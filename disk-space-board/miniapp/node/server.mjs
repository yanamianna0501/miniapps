/**
 * C 盘空间看板 —— Node 运行时入口。
 *
 * 职责：
 *   - 读取扫描清单快照并聚合成档位视图（只读，绝不修改原清单）
 *   - 记录「打算怎么处理」的决策，并把变更落盘后再广播
 *   - 提供按需下钻（目录树 / 目录内文件 / 全量路径搜索）
 *   - 按需触发一次非提权重扫，生成新快照供对比
 *
 * 不提供的能力（有意为之）：不删除、不移动、不重命名任何被测文件；
 * 不接受任意文件系统路径（快照来源固定写在 miniapp/config.json 里）。
 */

import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildIndex, buildSummary, walkTree } from './index-builder.mjs';
import { DecisionStore } from './decision-store.mjs';
import { scanRoot } from './scanner.mjs';
import { readSnapshot, csvEscape } from './csv.mjs';
import { BUCKETS, TIERS, bucketForDir } from './rules.mjs';

const MAX_BODY = 1_000_000;
const TREE_CHILDREN = 200;
const DIR_FILES_LIMIT = 500;
const SEARCH_LIMIT = 300;
const CACHE_ENTRIES = 24;

const round4 = (value) => Math.round(value * 10000) / 10000;
const gb = (mb) => round4(mb / 1024);

function createLru(max) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() {
      map.clear();
    },
  };
}

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectPromise(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON'));
      }
    });
    request.on('error', rejectPromise);
  });
}

export async function start(context) {
  const { logger } = context;

  const configPath = join(context.pluginRoot, 'miniapp', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const clientHtml = await fs.readFile(join(context.pluginRoot, 'miniapp', 'client', 'index.html'));

  await fs.mkdir(context.dataDir, { recursive: true });
  const snapshotsDir = join(context.dataDir, 'snapshots');
  await fs.mkdir(snapshotsDir, { recursive: true });

  const decisions = new DecisionStore(context.dataDir);
  await decisions.load();

  const workspace = await resolveWorkspaceRoot(context.pluginRoot, config);
  if (!workspace.root) {
    logger.warn('miniapp.workspace.not_found', { tried: workspace.tried.length });
  } else {
    logger.info('miniapp.workspace.resolved', { level: workspace.level });
  }

  const dirFilesCache = createLru(CACHE_ENTRIES);
  const searchCache = createLru(CACHE_ENTRIES);
  const clients = new Set();

  let indexAbort = new AbortController();
  const indexState = {
    id: null,
    status: workspace.root ? 'idle' : 'error',
    error: workspace.root ? null : '未能在工作区中找到扫描清单，请确认 miniapp/config.json 里的相对路径。',
    index: null,
    progress: null,
    startedAt: 0,
    buildCount: 0,
  };

  const rescanState = {
    running: false,
    progress: null,
    error: null,
    lastResult: null,
    abort: null,
    startedAt: 0,
    lastBroadcast: 0,
  };

  // ---------------------------------------------------------------- snapshots

  let registry = null;
  let stateFile = null;

  async function loadRegistry() {
    let rescans = [];
    try {
      const raw = await fs.readFile(join(snapshotsDir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items)) rescans = parsed.items;
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('miniapp.rescan.index_unreadable');
    }

    const entries = [];
    for (const source of config.sources) {
      const abs = workspace.root ? join(workspace.root, source.file) : null;
      const ok = abs ? await exists(abs) : false;
      entries.push({
        id: source.id,
        kind: 'source',
        label: source.label,
        note: source.note ?? '',
        displayPath: source.file,
        path: abs,
        exists: ok,
        deletable: false,
        createdAt: null,
        rows: null,
        sizeBytes: null,
      });
    }
    for (const item of rescans) {
      const abs = join(snapshotsDir, item.file);
      const ok = await exists(abs);
      let sizeBytes = item.sizeBytes ?? null;
      if (ok) {
        try {
          sizeBytes = (await fs.stat(abs)).size;
        } catch {
          sizeBytes = null;
        }
      }
      entries.push({
        id: item.id,
        kind: 'rescan',
        label: item.label,
        note: item.note ?? '',
        displayPath: item.file,
        path: abs,
        exists: ok,
        deletable: true,
        createdAt: item.createdAt ?? null,
        rows: item.rows ?? null,
        elapsedMs: item.elapsedMs ?? null,
        skipped: item.skipped ?? null,
        sizeBytes,
      });
    }

    stateFile = await readState();
    registry = entries;
    return entries;
  }

  async function readState() {
    try {
      const raw = await fs.readFile(join(context.dataDir, 'state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      return { activeSnapshotId: parsed.activeSnapshotId ?? null };
    } catch {
      return { activeSnapshotId: null };
    }
  }

  async function writeState(next) {
    stateFile = next;
    const target = join(context.dataDir, 'state.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(`${target}.tmp`, target);
  }

  async function activeSnapshot() {
    if (!registry) await loadRegistry();
    const usable = registry.filter((entry) => entry.exists);
    const preferred = usable.find((entry) => entry.id === stateFile?.activeSnapshotId);
    if (preferred) return preferred;
    const fallback = usable.find((entry) => entry.id === config.defaultSourceId) ?? usable[0] ?? null;
    return fallback;
  }

  // ---------------------------------------------------------------- index

  function snapshotSizeById(index) {
    const map = {};
    for (const bucket of BUCKETS) {
      const measured = index.buckets.get(bucket.id);
      if (measured) map[bucket.id] = { sizeGB: gb(measured.sizeMB), files: measured.files };
    }
    return map;
  }

  async function ensureIndex(force) {
    const active = await activeSnapshot();
    if (!active) {
      indexState.status = 'error';
      indexState.error = '没有可用的扫描清单：来源文件不存在，或尚未完成一次重新扫描。';
      indexState.index = null;
      return;
    }
    if (!force && indexState.status === 'ready' && indexState.id === active.id && indexState.index) return;
    if (indexState.status === 'loading' && indexState.id === active.id) return;

    indexAbort.abort();
    indexAbort = new AbortController();
    indexState.id = active.id;
    indexState.status = 'loading';
    indexState.index = null;
    indexState.error = null;
    indexState.startedAt = Date.now();
    indexState.progress = { rows: 0, elapsedMs: 0 };

    const signal = indexAbort.signal;
    try {
      const index = await buildIndex(active.path, {
        signal,
        onProgress: (progress) => {
          indexState.progress = { rows: progress.rows, elapsedMs: Date.now() - indexState.startedAt };
        },
      });
      if (signal.aborted) return;
      indexState.index = index;
      indexState.status = 'ready';
      indexState.buildCount += 1;
      indexState.progress = null;
      logger.info('miniapp.index.ready', {
        rows: index.source.rows,
        malformed: index.source.malformed,
        elapsedMs: index.source.elapsedMs,
      });
      await decisions.refreshBucketSizes(snapshotSizeById(index));
      broadcast('index', { status: 'ready', sourceId: active.id, rows: index.source.rows });
    } catch (error) {
      if (signal.aborted) return;
      indexState.status = 'error';
      indexState.index = null;
      indexState.error = `读取扫描清单失败：${error.message}`;
      logger.error('miniapp.index.failed', { code: error.code ?? 'unknown' });
    }
  }

  // ---------------------------------------------------------------- SSE

  function broadcast(type, payload) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  // ---------------------------------------------------------------- payloads

  function snapshotListPayload() {
    const activeId = indexState.id ?? stateFile?.activeSnapshotId ?? null;
    return (registry ?? []).map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      note: entry.note,
      displayPath: entry.displayPath,
      exists: entry.exists,
      deletable: entry.deletable,
      active: entry.id === activeId,
      rows: entry.rows,
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
      elapsedMs: entry.elapsedMs ?? null,
      skipped: entry.skipped ?? null,
    }));
  }

  function statePayload() {
    const base = {
      status: indexState.status,
      error: indexState.error,
      progress: indexState.progress,
      source: null,
      snapshots: snapshotListPayload(),
      workspaceResolved: Boolean(workspace.root),
      ruleSummary: {
        tiers: TIERS.length,
        buckets: BUCKETS.length,
        unresolved: BUCKETS.filter((bucket) => bucket.status === 'unresolved').length,
        snapshotDate: '2026-10-03',
      },
      decisions: decisions.summary(),
      rescan: {
        running: rescanState.running,
        progress: rescanState.progress,
        error: rescanState.error,
        lastResult: rescanState.lastResult,
        root: config.rescanRoot,
      },
    };

    const index = indexState.index;
    if (!index) {
      return {
        ...base,
        totals: null,
        matched: null,
        kpis: null,
        tiers: null,
        unclassified: null,
        extensions: null,
        topFiles: null,
      };
    }

    const summary = buildSummary(index);
    const decisionSummary = base.decisions;
    const activeEntry = (registry ?? []).find((entry) => entry.id === indexState.id);
    return {
      ...base,
      source: {
        id: indexState.id,
        label: activeEntry?.label ?? indexState.id,
        kind: activeEntry?.kind ?? 'source',
        displayPath: activeEntry?.displayPath ?? '',
        note: activeEntry?.note ?? '',
        sizeBytes: index.source.sizeBytes,
        mtimeMs: index.source.mtimeMs,
        rows: index.source.rows,
        malformed: index.source.malformed,
        dirs: index.source.dirs,
        elapsedMs: index.source.elapsedMs,
        builtAt: index.source.builtAt,
      },
      totals: { sizeGB: gb(index.totals.sizeMB), files: index.totals.files },
      matched: { sizeGB: gb(index.matched.sizeMB), files: index.matched.files },
      kpis: {
        releasableGB: decisionSummary.cleanGB,
        migratableGB: decisionSummary.migrateGB,
        pendingGB: decisionSummary.laterGB,
        decidedCount: decisionSummary.total,
      },
      tiers: summary.tiers,
      unclassified: summary.unclassified,
      extensions: summary.extensions,
      topFiles: summary.topFiles,
    };
  }

  function treePayload(dirPath) {
    const index = indexState.index;
    if (!index) return null;
    const cleaned = dirPath && dirPath.length > 0 ? dirPath : 'C:\\';
    const node = walkTree(index.tree, cleaned);
    if (!node) return null;

    const normalize = (path) => path.replace(/\\+$/, '').replace(/\\$/, '');
    const selfPath = normalize(cleaned).endsWith(':') ? `${normalize(cleaned)}\\` : normalize(cleaned);
    const own = bucketForDir(selfPath);

    const childDirs = [];
    if (node.c) {
      for (const [name, child] of node.c) {
        const childPath = join(selfPath, name);
        const bucket = bucketForDir(childPath);
        childDirs.push({
          name,
          path: childPath,
          sizeGB: gb(child.s),
          files: child.f,
          directFiles: child.dfs,
          bucketId: bucket ? bucket.id : null,
          bucketName: bucket ? bucket.name : null,
          truncated: Boolean(child.t),
        });
      }
    }
    childDirs.sort((a, b) => b.sizeGB - a.sizeGB);

    const parts = selfPath.split('\\').filter((part) => part.length > 0);
    const breadcrumb = parts.map((part, position) => {
      const prefix = parts.slice(0, position + 1).join('\\');
      return { name: part, path: position === 0 ? `${prefix}\\` : prefix };
    });

    return {
      path: selfPath,
      breadcrumb,
      self: {
        sizeGB: gb(node.s),
        files: node.f,
        directFiles: node.dfs,
        directGB: gb(node.ds),
        bucketId: own ? own.id : null,
        bucketName: own ? own.name : null,
        truncated: Boolean(node.t),
      },
      dirs: childDirs.slice(0, TREE_CHILDREN),
      dirsTotal: childDirs.length,
      topFiles: (node.top ?? []).map(([name, sizeMB]) => ({ name, sizeMB })),
    };
  }

  function prefixOf(dirPath) {
    const trimmed = dirPath.replace(/\\+$/, '');
    return `${trimmed.toLowerCase()}\\`;
  }

  async function scanSnapshotQuery(filter, limit) {
    const active = await activeSnapshot();
    if (!active) throw new Error('没有可用的扫描清单');
    const startedAt = Date.now();
    const hits = [];
    const result = await readSnapshot(active.path, (path, ext, sizeMB, mtime) => {
      if (filter(path.toLowerCase())) hits.push({ path, ext, sizeMB, mtime });
    });
    hits.sort((a, b) => b.sizeMB - a.sizeMB);
    return {
      rows: result.rows,
      malformed: result.malformed,
      matched: hits.length,
      elapsedMs: Date.now() - startedAt,
      files: hits.slice(0, limit),
    };
  }

  // ---------------------------------------------------------------- routes

  function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  function sendText(response, status, contentType, body, extraHeaders = {}) {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...extraHeaders });
    response.end(body);
  }

  async function handleApi(request, response, url) {
    const route = `${request.method} ${url.pathname}`;

    switch (route) {
      case 'GET /api/state': {
        sendJson(response, 200, statePayload());
        return true;
      }

      case 'GET /api/tree': {
        if (!indexState.index) {
          sendJson(response, 503, { error: '快照仍在加载，请稍后重试。' });
          return true;
        }
        const payload = treePayload(url.searchParams.get('path') ?? 'C:\\');
        if (!payload) {
          sendJson(response, 404, { error: '该目录不在当前快照中。' });
          return true;
        }
        sendJson(response, 200, payload);
        return true;
      }

      case 'GET /api/dir-files': {
        const dir = url.searchParams.get('path');
        if (!dir) {
          sendJson(response, 400, { error: '缺少 path 参数。' });
          return true;
        }
        const cached = dirFilesCache.get(dir);
        if (cached) {
          sendJson(response, 200, { ...cached, cached: true });
          return true;
        }
        if (indexState.status === 'loading') {
          sendJson(response, 503, { error: '快照仍在加载，请稍后重试。' });
          return true;
        }
        const prefix = prefixOf(dir);
        const payload = await scanSnapshotQuery((lower) => lower.startsWith(prefix), DIR_FILES_LIMIT);
        const body = { ...payload, path: dir, cached: false };
        dirFilesCache.set(dir, body);
        sendJson(response, 200, body);
        return true;
      }

      case 'GET /api/search': {
        const query = (url.searchParams.get('q') ?? '').trim();
        if (query.length < 2) {
          sendJson(response, 400, { error: '请输入至少 2 个字符。' });
          return true;
        }
        const cached = searchCache.get(query.toLowerCase());
        if (cached) {
          sendJson(response, 200, { ...cached, cached: true });
          return true;
        }
        if (indexState.status === 'loading') {
          sendJson(response, 503, { error: '快照仍在加载，请稍后重试。' });
          return true;
        }
        const needle = query.toLowerCase();
        const payload = await scanSnapshotQuery((lower) => lower.includes(needle), SEARCH_LIMIT);
        const body = { ...payload, query, cached: false };
        searchCache.set(query.toLowerCase(), body);
        sendJson(response, 200, body);
        return true;
      }

      case 'POST /api/decisions': {
        const body = await readJsonBody(request);
        const saved = await decisions.upsert(body.items);
        const summary = decisions.summary();
        broadcast('state', { reason: 'decisions', summary });
        sendJson(response, 200, { saved: saved.length, summary });
        return true;
      }

      case 'POST /api/decisions/remove': {
        const body = await readJsonBody(request);
        const removed = await decisions.remove(String(body.kind ?? ''), String(body.target ?? ''));
        const summary = decisions.summary();
        broadcast('state', { reason: 'decisions', summary });
        sendJson(response, 200, { removed: removed !== null, summary });
        return true;
      }

      case 'POST /api/decisions/clear': {
        if (body_confirm(request, await readJsonBody(request)) === false) {
          sendJson(response, 400, { error: '需要确认后才会清空决策。' });
          return true;
        }
        await decisions.clear();
        const summary = decisions.summary();
        broadcast('state', { reason: 'decisions', summary });
        sendJson(response, 200, { cleared: true, summary });
        return true;
      }

      case 'GET /api/export/decisions.csv': {
        const csv = decisions.toCsv(csvEscape);
        sendText(response, 200, 'text/csv; charset=utf-8', csv, {
          'content-disposition': 'attachment; filename="disk-board-decisions.csv"',
        });
        return true;
      }

      case 'POST /api/rescan': {
        const body = await readJsonBody(request);
        if (rescanState.running) {
          sendJson(response, 409, { error: '已有一次重新扫描在进行中。' });
          return true;
        }
        startRescan({ confirmed: body.confirm === true });
        sendJson(response, 202, { started: true, root: config.rescanRoot });
        return true;
      }

      case 'POST /api/rescan/cancel': {
        if (!rescanState.running || !rescanState.abort) {
          sendJson(response, 409, { error: '当前没有正在进行的扫描。' });
          return true;
        }
        rescanState.abort.abort();
        sendJson(response, 202, { cancelling: true });
        return true;
      }

      case 'GET /api/rescan/status': {
        sendJson(response, 200, {
          running: rescanState.running,
          progress: rescanState.progress,
          error: rescanState.error,
          lastResult: rescanState.lastResult,
        });
        return true;
      }

      case 'POST /api/snapshots/activate': {
        const body = await readJsonBody(request);
        const id = String(body.id ?? '');
        if (!registry) await loadRegistry();
        const entry = registry.find((item) => item.id === id);
        if (!entry) {
          sendJson(response, 404, { error: '未找到该快照。' });
          return true;
        }
        if (!entry.exists) {
          sendJson(response, 409, { error: '该快照的清单文件已不存在。' });
          return true;
        }
        await writeState({ activeSnapshotId: id });
        dirFilesCache.clear();
        searchCache.clear();
        await ensureIndex(true);
        broadcast('index', { status: 'loading', sourceId: id });
        sendJson(response, 200, { active: id });
        return true;
      }

      case 'POST /api/snapshots/delete': {
        const body = await readJsonBody(request);
        const id = String(body.id ?? '');
        if (!registry) await loadRegistry();
        const entry = registry.find((item) => item.id === id);
        if (!entry || !entry.deletable) {
          sendJson(response, 403, { error: '只能删除本看板自己生成的快照。' });
          return true;
        }
        await deleteRescan(id);
        sendJson(response, 200, { deleted: id });
        return true;
      }

      case 'POST /api/snapshots/reload': {
        dirFilesCache.clear();
        searchCache.clear();
        await ensureIndex(true);
        sendJson(response, 200, { reloading: true });
        return true;
      }

      default:
        return false;
    }
  }

  function body_confirm(_request, body) {
    return body?.confirm === true;
  }

  // ---------------------------------------------------------------- rescan

  async function deleteRescan(id) {
    const raw = await fs.readFile(join(snapshotsDir, 'index.json'), 'utf8').catch(() => null);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const target = items.find((item) => item.id === id);
    if (!target) return;
    const file = join(snapshotsDir, target.file);
    if (resolve(file).startsWith(resolve(snapshotsDir))) {
      await fs.unlink(file).catch(() => undefined);
    }
    const next = items.filter((item) => item.id !== id);
    await fs.writeFile(join(snapshotsDir, 'index.json'), JSON.stringify({ version: 1, items: next }, null, 2), 'utf8');
    if (stateFile?.activeSnapshotId === id) {
      await writeState({ activeSnapshotId: config.defaultSourceId });
    }
    await loadRegistry();
    await ensureIndex(true);
    broadcast('index', { status: 'loading', sourceId: config.defaultSourceId });
  }

  function startRescan(options) {
    const stamp = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const id = `rescan-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
      stamp.getHours(),
    )}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const finalFile = `${id}.csv`;
    const partial = join(snapshotsDir, `${id}.csv.partial`);

    rescanState.running = true;
    rescanState.error = null;
    rescanState.progress = { dirs: 0, files: 0, bytes: 0, elapsedMs: 0 };
    rescanState.startedAt = Date.now();
    rescanState.abort = new AbortController();
    broadcast('rescan', { running: true, progress: rescanState.progress });

    const abort = rescanState.abort;
    scanRoot({
      root: config.rescanRoot,
      outFile: partial,
      signal: abort.signal,
      onProgress: (progress) => {
        rescanState.progress = progress;
        const now = Date.now();
        if (now - rescanState.lastBroadcast > 800) {
          rescanState.lastBroadcast = now;
          broadcast('rescan', { running: true, progress });
        }
      },
    })
      .then(async ({ stats, skipped }) => {
        if (stats.aborted || abort.signal.aborted) {
          await fs.unlink(partial).catch(() => undefined);
          rescanState.running = false;
          rescanState.progress = null;
          rescanState.error = '扫描已取消，未生成快照。';
          broadcast('rescan', { running: false, cancelled: true });
          return;
        }
        const finalPath = join(snapshotsDir, finalFile);
        await fs.rename(partial, finalPath);
        const info = await fs.stat(finalPath);
        const entry = {
          id,
          file: finalFile,
          label: `重新扫描 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(
            stamp.getHours(),
          )}:${pad(stamp.getMinutes())}`,
          note: options.confirmed
            ? '由看板触发的一次非提权全盘扫描；无权限目录已跳过并列在结果中。'
            : '由看板触发的一次非提权全盘扫描。',
          createdAt: Date.now(),
          rows: stats.files,
          sizeBytes: info.size,
          elapsedMs: stats.elapsedMs,
          skipped: { count: stats.errors, links: stats.skippedLinks, samples: skipped.slice(0, 20) },
        };
        await loadRegistry();
        const raw = await fs.readFile(join(snapshotsDir, 'index.json'), 'utf8').catch(() => null);
        const parsed = raw ? JSON.parse(raw) : { version: 1, items: [] };
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        items.unshift(entry);
        await fs.writeFile(
          join(snapshotsDir, 'index.json'),
          JSON.stringify({ version: 1, items }, null, 2),
          'utf8',
        );
        await writeState({ activeSnapshotId: id });
        await loadRegistry();

        rescanState.running = false;
        rescanState.progress = null;
        rescanState.lastResult = {
          id,
          files: stats.files,
          bytes: stats.bytes,
          elapsedMs: stats.elapsedMs,
          skipped: stats.errors,
          skippedLinks: stats.skippedLinks,
          truncated: stats.truncated,
        };
        logger.info('miniapp.rescan.done', {
          files: stats.files,
          elapsedMs: stats.elapsedMs,
          errors: stats.errors,
        });
        broadcast('rescan', { running: false, done: true, result: rescanState.lastResult });
        await ensureIndex(true);
      })
      .catch(async (error) => {
        await fs.unlink(partial).catch(() => undefined);
        rescanState.running = false;
        rescanState.progress = null;
        rescanState.error = `扫描失败：${error.message}`;
        logger.error('miniapp.rescan.failed', { code: error.code ?? 'unknown' });
        broadcast('rescan', { running: false, error: rescanState.error });
      });
  }

  // ---------------------------------------------------------------- server

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');

    void (async () => {
      try {
        if (url.pathname === '/api/events' && request.method === 'GET') {
          response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          response.write(`retry: 3000\n\n`);
          clients.add(response);
          const keepAlive = setInterval(() => {
            try {
              response.write(': keep-alive\n\n');
            } catch {
              clearInterval(keepAlive);
            }
          }, 25000);
          request.on('close', () => {
            clearInterval(keepAlive);
            clients.delete(response);
          });
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApi(request, response, url);
          if (!handled) sendJson(response, 404, { error: '未知接口。' });
          return;
        }

        if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/')) {
          if (url.pathname === '/') {
            response.writeHead(302, { location: '/dashboard' });
            response.end();
            return;
          }
          sendText(response, 200, 'text/html; charset=utf-8', clientHtml);
          return;
        }

        if (request.method === 'GET' && url.pathname === '/favicon.ico') {
          response.writeHead(204);
          response.end();
          return;
        }

        sendJson(response, 404, { error: '未找到该页面。' });
      } catch (error) {
        const isValidation = typeof error.message === 'string' && !error.code;
        if (isValidation) {
          logger.debug('miniapp.request.rejected', { path: url.pathname });
        } else {
          logger.warn('miniapp.request.failed', { path: url.pathname, code: error.code ?? 'unknown' });
        }
        if (!response.headersSent) {
          sendJson(response, isValidation ? 400 : 500, { error: error.message || '请求处理失败。' });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolveListen();
    });
  });

  await loadRegistry();
  logger.info('miniapp.runtime.listening', { snapshots: registry.length });

  // 索引在后台构建：start() 只负责安装路由并进入就绪状态。
  void ensureIndex(false);

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    indexAbort.abort();
    if (rescanState.abort) rescanState.abort.abort();
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // 忽略关闭时的写入失败
      }
    }
    clients.clear();
    await new Promise((resolveClose) => {
      server.close(() => resolveClose());
    });
  };
  const onAbort = () => {
    void dispose();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();

  return { dispose };
}

// ---------------------------------------------------------------- helpers

/** 从插件目录向上找包含配置清单的那个目录，最多上溯 3 层。 */
async function resolveWorkspaceRoot(pluginRoot, config) {
  const candidates = [];
  let current = pluginRoot;
  for (let level = 0; level < 4; level += 1) {
    candidates.push({ dir: current, level });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    for (const source of config.sources) {
      if (await exists(join(candidate.dir, source.file))) {
        return { root: candidate.dir, level: candidate.level, matchedBy: source.id, tried: [] };
      }
    }
  }
  return { root: null, level: -1, tried: candidates.map((item) => item.dir) };
}
