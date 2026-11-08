// Locate and open MiniMax Code's local runtime usage database, read-only.
//
// Two drivers are attempted in order:
//   1. `node:sqlite`  - built in, no dependency, used when the runtime Node exposes it.
//   2. `sqlite-bridge.py` - spawned read-only Python fallback for runtimes without `node:sqlite`.
// Both expose the same `query(sql, params)` interface so the report layer stays driver-agnostic.
//
// The connection is always read-only. This module additionally reports two facts the report layer
// needs to stay safe on an evolving schema:
//   * `jsonSupport` - whether SQLite's JSON1 functions can be used to read small fields out of
//     `local_runtime_message_rows.data_json` instead of moving whole multi-KB blobs into Node.
//   * `stat` / `schemaVersion` - the identity of the database as opened, so a replaced file or a
//     migrated schema can be detected and the handle reopened.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Relative layout of the usage database inside an application data directory. */
const DB_SEGMENTS = ['v2', 'sqlite', 'runtime-state.sqlite'];
const SETTINGS_NAME = 'settings.json';
const BRIDGE_PATH = fileURLToPath(new URL('./sqlite-bridge.py', import.meta.url));
const BRIDGE_TIMEOUT_MS = 20000;
const MAX_ROWS = 50000;
const MAX_ANCESTORS = 8;
const JSON_PROBE_SQL = `SELECT json_extract('{"probe":{"value":7}}', '$.probe.value') AS value`;

/** Read the optional per-plugin settings file kept in the Host-provided data directory. */
export function readSettings(context) {
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(join(context.dataDir, SETTINGS_NAME), 'utf8'));
  } catch {
    parsed = {};
  }
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    dataDirOverride: text(parsed?.dataDirOverride),
    pythonPath: text(parsed?.pythonPath),
  };
}

function* ancestors(start) {
  let current = start;
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    yield current;
    const parent = dirname(current);
    if (!parent || parent === current) return;
    current = parent;
  }
}

/**
 * Walk up from every candidate root and return the first directory holding the usage database.
 * The plugin never guesses the active profile: the injected `dataDir` lives inside it.
 */
export function resolveDataRoot(context, settings) {
  const roots = [settings.dataDirOverride, context.dataDir, context.pluginRoot, process.cwd()];
  const visited = new Set();
  for (const root of roots) {
    if (!root) continue;
    for (const candidate of ancestors(root)) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const dbPath = join(candidate, ...DB_SEGMENTS);
      if (existsSync(dbPath)) {
        return {
          dataDir: candidate,
          dbPath,
          discoveredVia: candidate === settings.dataDirOverride ? 'settings-override' : 'ancestor-walk',
        };
      }
    }
  }
  return null;
}

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** File identity used to notice a replaced database without tripping on ordinary writes. */
function statOf(dbPath) {
  try {
    const stats = statSync(dbPath);
    return {
      size: stats.size,
      mtimeMs: Math.round(stats.mtimeMs),
      birthtimeMs: Math.round(stats.birthtimeMs),
      ino: typeof stats.ino === 'number' ? stats.ino : 0,
    };
  } catch {
    return null;
  }
}

function readSchemaVersion(source) {
  try {
    const rows = source.query('PRAGMA schema_version');
    const value = rows?.[0]?.schema_version;
    return value === undefined || value === null ? null : Number(value);
  } catch {
    return null;
  }
}

function probeJsonSupport(source) {
  try {
    const rows = source.query(JSON_PROBE_SQL);
    return Number(rows?.[0]?.value) === 7;
  } catch {
    return false;
  }
}

/**
 * True when the open handle can no longer be trusted: the file disappeared, was replaced by a
 * different file, or the schema moved on. Ordinary row growth (size/mtime increasing) is NOT a
 * reason to reopen - the application writes on every model call.
 */
export function isSourceStale(source) {
  if (!source?.ok || !source.dbPath) return true;
  const current = statOf(source.dbPath);
  if (!current) return true;
  const previous = source.stat;
  if (previous) {
    if (current.size < previous.size) return true;
    if (previous.ino && current.ino && current.ino !== previous.ino) return true;
    if (previous.birthtimeMs && current.birthtimeMs && Math.abs(current.birthtimeMs - previous.birthtimeMs) > 1000) {
      return true;
    }
  }
  const version = readSchemaVersion(source);
  if (version !== null && source.schemaVersion !== null && version !== source.schemaVersion) return true;
  return false;
}

async function openNodeSqlite(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Assert the option was honoured; an unintended write handle must not stay open.
    if (typeof database.isOpen === 'boolean' && !database.isOpen) throw new Error('database not open');
    database.prepare('SELECT 1').all();
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    driver: 'node:sqlite',
    query(sql, params = []) {
      return database.prepare(sql).all(...params);
    },
    close() {
      database.close();
    },
  };
}

function runBridge(command, payload, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      child.kill();
      finish(new Error('bridge aborted'));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`bridge timeout after ${BRIDGE_TIMEOUT_MS}ms`));
    }, BRIDGE_TIMEOUT_MS);

    child.on('error', (error) => finish(error));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) onAbort();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`bridge exited with ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error(`bridge returned unparsable output: ${stdout.trim().slice(0, 300)}`));
      }
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function pythonCandidates(settings) {
  const candidates = [];
  if (settings.pythonPath) candidates.push(settings.pythonPath);
  if (process.env.MINIMAX_CONTEXT_PYTHON) candidates.push(process.env.MINIMAX_CONTEXT_PYTHON);
  candidates.push('python', 'python3', 'py');
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'));
  }
  return candidates;
}

async function openPythonBridge(command, dbPath, signal) {
  const query = async (sql, params = []) => {
    const result = await runBridge(command, { db: dbPath, sql, params, limit: MAX_ROWS }, signal);
    if (!result?.ok) throw new Error(result?.error ?? 'bridge reported an unknown failure');
    const columns = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return rows.map((row) => {
      const record = {};
      columns.forEach((column, index) => {
        record[column] = row[index];
      });
      return record;
    });
  };
  await query('SELECT 1 AS ok');
  return { driver: `python-bridge:${command}`, query, close() {} };
}

/** Attach the capability, identity, and staleness facts every report query relies on. */
function decorate(source, located, attempts) {
  return {
    ok: true,
    ...located,
    ...source,
    jsonSupport: probeJsonSupport(source),
    schemaVersion: readSchemaVersion(source),
    stat: statOf(located.dbPath),
    openedAtMs: Date.now(),
    attempts,
  };
}

/**
 * Resolve the database and return a working read-only source.
 * The result always carries `attempts` so the runtime self-check can explain a driver failure.
 */
export async function openSource(context, signal) {
  const settings = readSettings(context);
  const located = resolveDataRoot(context, settings);
  if (!located) {
    return {
      ok: false,
      code: 'data-dir-not-found',
      message: 'No v2/sqlite/runtime-state.sqlite found above the injected data directory.',
      attempts: [],
    };
  }

  const attempts = [];
  try {
    const source = await openNodeSqlite(located.dbPath);
    return decorate(source, located, attempts);
  } catch (error) {
    attempts.push({ driver: 'node:sqlite', error: describe(error) });
  }

  for (const command of pythonCandidates(settings)) {
    try {
      const source = await openPythonBridge(command, located.dbPath, signal);
      return decorate(source, located, attempts);
    } catch (error) {
      attempts.push({ driver: `python-bridge:${command}`, error: describe(error) });
    }
  }

  return {
    ok: false,
    code: 'no-driver',
    message: 'Neither node:sqlite nor the Python bridge could read the usage database.',
    ...located,
    attempts,
  };
}
