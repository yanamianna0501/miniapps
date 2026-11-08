// Mini App Node entry: serves the context dashboard page and its read-only JSON API.
//
// Data path: local runtime usage database -> read-only source (usage-source.mjs) -> aggregates
// (usage-report.mjs) -> JSON routes -> static Client. The board has no mutations; every route is a
// bounded read, and the context-telemetry layer degrades to `available: false` instead of failing
// the request.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isSourceStale, openSource } from './usage-source.mjs';
import {
  buildOverview,
  buildSessionDetail,
  DETAIL_PAGE_DEFAULT,
  DETAIL_PAGE_MAX,
  RANGE_KEYS,
} from './usage-report.mjs';

const CLIENT_FILES = new Map([
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const DIAGNOSTICS_FILE = 'datasource.json';
const DIAGNOSTICS_MIN_INTERVAL_MS = 15000;
const SLOW_SECTION_MS = 1500;

/**
 * @param {import('./miniapp-api.js').MiniAppContext} context
 * @returns {Promise<import('./miniapp-api.js').MiniAppLifecycle>}
 */
export async function start(context) {
  const clientRoot = join(context.pluginRoot, 'miniapp', 'client');
  const [html, assets] = await Promise.all([
    readFile(join(clientRoot, 'index.html')),
    Promise.all(
      [...CLIENT_FILES.values()].map(async (entry) => [
        entry.file,
        await readFile(join(clientRoot, entry.file)),
      ]),
    ),
  ]);
  const assetBodies = new Map(assets);

  let source = await openSource(context, context.signal);
  let firstBusinessReadDone = false;
  let reopenCount = 0;
  let lastReopenReason = null;
  let lastDiagnosticsAtMs = 0;

  const recordDiagnostics = (partial, force = false) => {
    const now = Date.now();
    if (!force && now - lastDiagnosticsAtMs < DIAGNOSTICS_MIN_INTERVAL_MS) return;
    lastDiagnosticsAtMs = now;
    const path = join(context.dataDir, DIAGNOSTICS_FILE);
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      previous = {};
    }
    try {
      mkdirSync(context.dataDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...previous, ...partial }, null, 2)}\n`, 'utf8');
    } catch (error) {
      context.logger.warn('miniapp.diagnostics.write_failed', { reason: String(error?.message ?? error) });
    }
  };

  const describeSource = () => ({
    ok: source.ok,
    driver: source.ok ? source.driver : null,
    jsonSupport: source.ok ? source.jsonSupport !== false : null,
    dataDir: source.dataDir ?? null,
    dbPath: source.dbPath ?? null,
    discoveredVia: source.discoveredVia ?? null,
    schemaVersion: source.schemaVersion ?? null,
    code: source.code ?? null,
    message: source.message ?? null,
    attempts: source.attempts ?? [],
    reopenCount,
    lastReopenReason,
  });

  recordDiagnostics(
    { resolvedAtMs: Date.now(), ...describeSource() },
    true,
  );
  if (source.ok) {
    context.logger.info('miniapp.datasource.ready', {
      driver: source.driver,
      via: source.discoveredVia,
      jsonSupport: source.jsonSupport !== false,
    });
  } else {
    context.logger.warn('miniapp.datasource.unavailable', { code: source.code });
  }

  /** Reopen the read-only handle after a failure, a replaced file, or a schema change. */
  const reopen = async (reason) => {
    source.close?.();
    source = await openSource(context, context.signal);
    reopenCount += 1;
    lastReopenReason = reason;
    recordDiagnostics({ resolvedAtMs: Date.now(), ...describeSource() }, true);
    return source.ok;
  };

  const withSource = async (work) => {
    if (!source.ok || isSourceStale(source)) {
      const reason = source.ok ? 'stale-database' : 'source-unavailable';
      if (!(await reopen(reason))) throw new Error(source.message ?? 'usage source unavailable');
    }
    try {
      return await work(source);
    } catch (error) {
      const retried = await reopen(`query-failed: ${String(error?.message ?? error).slice(0, 160)}`);
      if (!retried) throw error;
      return work(source);
    }
  };

  const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  };

  const warningsFor = (timings = {}) => {
    const slow = [];
    for (const [key, value] of Object.entries(timings)) {
      if (typeof value === 'number' && value > SLOW_SECTION_MS) slow.push(`${key}=${value}ms`);
    }
    return slow;
  };

  const handleOverview = async (url, response) => {
    const requested = url.searchParams.get('range') ?? '7d';
    const range = RANGE_KEYS.includes(requested) ? requested : '7d';
    const payload = await withSource((active) => buildOverview(active, range, Date.now()));
    const slow = warningsFor(payload.timings);
    if (slow.length) {
      context.logger.warn('miniapp.overview.slow', { range, slow: slow.join(', ') });
    }
    if (!firstBusinessReadDone) {
      firstBusinessReadDone = true;
      recordDiagnostics(
        {
          firstBusinessReadAtMs: Date.now(),
          ...describeSource(),
          observed: {
            sessions: payload.kpi.sessions,
            calls: payload.kpi.calls,
            snapshots: payload.context?.samples ?? 0,
            snapshotSessions: payload.context?.sessions ?? 0,
            models: (payload.models ?? []).length,
            firstTsMs: payload.kpi.firstTsMs,
            lastTsMs: payload.kpi.lastTsMs,
          },
          timings: payload.timings,
        },
        true,
      );
      context.logger.info('miniapp.business.read_ok', {
        calls: payload.kpi.calls,
        sessions: payload.kpi.sessions,
        snapshots: payload.context?.samples ?? 0,
        models: (payload.models ?? []).length,
      });
    }
    recordDiagnostics({ lastOverviewAtMs: Date.now(), timings: payload.timings, ...describeSource() });
    sendJson(response, 200, { ...payload, source: describeSource() });
  };

  const handleSession = async (url, response) => {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      sendJson(response, 400, { error: 'invalid_session_id' });
      return;
    }
    const requestedRange = url.searchParams.get('range');
    const range = requestedRange && RANGE_KEYS.includes(requestedRange) ? requestedRange : 'all';
    const limit = clampInt(url.searchParams.get('limit'), DETAIL_PAGE_DEFAULT, 1, DETAIL_PAGE_MAX);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const payload = await withSource((active) =>
      buildSessionDetail(active, sessionId, { limit, offset, range, nowMs: Date.now() }),
    );
    sendJson(response, 200, payload);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';

    if (method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    const route = () => {
      if (path === '/dashboard') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return null;
      }
      const asset = CLIENT_FILES.get(path);
      if (asset) {
        response.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        response.end(assetBodies.get(asset.file));
        return null;
      }
      if (path === '/api/overview') return handleOverview(url, response);
      if (path === '/api/session') return handleSession(url, response);
      if (path === '/api/health') {
        sendJson(response, 200, {
          ok: source.ok,
          driver: source.ok ? source.driver : null,
          jsonSupport: source.ok ? source.jsonSupport !== false : null,
          reopenCount,
          lastReopenReason,
        });
        return null;
      }
      sendJson(response, 404, { error: 'not_found' });
      return null;
    };

    try {
      Promise.resolve(route()).catch((error) => {
        context.logger.error('miniapp.request.failed', { route: path, reason: String(error?.message ?? error) });
        if (!response.headersSent) sendJson(response, 500, { error: 'read_failed' });
        else response.end();
      });
    } catch (error) {
      context.logger.error('miniapp.request.threw', { route: path, reason: String(error?.message ?? error) });
      if (!response.headersSent) sendJson(response, 500, { error: 'read_failed' });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  context.logger.info('miniapp.runtime.listening', { surface: '/dashboard' });

  let disposal;
  const dispose = () => {
    if (disposal) return disposal;
    context.signal.removeEventListener('abort', onAbort);
    disposal = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }).then(() => {
      source.close?.();
      source = { ok: false };
    });
    return disposal;
  };
  const onAbort = () => {
    void dispose().catch(() => undefined);
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

/** Clamp a query parameter into a range; missing or unparsable values fall back to the default. */
function clampInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
