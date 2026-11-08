// Shape MiniMax Code's token-usage and context-telemetry rows into the dashboard payload.
//
// Reads, read-only:
//   * `local_runtime_token_usage`     - per-model-call token accounting (totals, daily, sessions).
//   * `local_runtime_sessions`        - session titles / workspaces.
//   * `local_runtime_message_rows`    - per-call context telemetry inside `data_json`
//                                       (`context_usage` + `context_usage_telemetry`).
//
// The context layer never scans the message table: `data_json` averages ~12 KB and grows with every
// model call, so snapshots are read per session through the `(session_id, id)` index, newest first,
// with a hard row cap. Only small fields leave SQLite (`json_extract`), never whole blobs - except
// in the JSON1-unsupported fallback, which is bounded by the same cap.

const DAY_MS = 86400000;
const HEATMAP_DAYS = 56;
const CHART_MAX_DAYS = 92;
const RANGE_DAYS = { '7d': 7, '30d': 30, all: null };
const CONTEXT_SESSION_LIMIT = 1500;
export const WINDOW_ROW_LIMIT = 200000;
const SERIES_MAX_POINTS = 600;
const ID_CHUNK = 400;
const UNKNOWN_MODEL = '未知模型';

export const DETAIL_PAGE_DEFAULT = 200;
export const DETAIL_PAGE_MAX = 1000;

/** Component kinds emitted by the runtime, in display order. */
export const COMPONENT_ORDER = ['SYSTEM_PROMPT', 'MEMORY', 'TOOLS', 'SKILLS', 'MESSAGES', 'OTHER'];
const COMPONENT_LABELS = {
  SYSTEM_PROMPT: '系统提示',
  MEMORY: '记忆',
  TOOLS: '工具',
  SKILLS: '技能',
  MESSAGES: '消息',
  OTHER: '其他',
};

export const RANGE_KEYS = Object.keys(RANGE_DAYS);

const SNAPSHOT_COLUMNS_SQL = `
SELECT m.id AS id,
       m.turn_id AS turn_id,
       m.created_at_ms AS created_at_ms,
       json_extract(m.data_json, '$.context_usage.usedTokens') AS used_tokens,
       json_extract(m.data_json, '$.context_usage.contextWindowTokens') AS window_tokens,
       json_extract(m.data_json, '$.context_usage.totalCountSource') AS count_source,
       json_extract(m.data_json, '$.context_usage_telemetry.model') AS model,
       json_extract(m.data_json, '$.context_usage_telemetry.divergenceRate') AS divergence_rate,
       json_extract(m.data_json, '$.context_usage_telemetry.toolCalibrationStatus') AS calibration_status
  FROM local_runtime_message_rows m
 WHERE m.session_id = ?
   AND m.role = 'assistant'
   AND m.data_json LIKE '%"context_usage"%'
 ORDER BY m.id DESC
 LIMIT ${CONTEXT_SESSION_LIMIT}`;

const SNAPSHOT_RAW_SQL = `
SELECT m.id AS id,
       m.turn_id AS turn_id,
       m.created_at_ms AS created_at_ms,
       m.data_json AS data_json
  FROM local_runtime_message_rows m
 WHERE m.session_id = ?
   AND m.role = 'assistant'
   AND m.data_json LIKE '%"context_usage"%'
 ORDER BY m.id DESC
 LIMIT ${CONTEXT_SESSION_LIMIT}`;

const TOKEN_PAGE_COLUMNS = `id, turn_id, ts, input_tokens, output_tokens, reasoning_tokens,
            cache_read_tokens, cache_write_tokens, agent_name, framework_type`;

function num(value) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maybeNum(value) {
  return value === null || value === undefined ? null : num(value);
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function ratioOf(used, windowTokens) {
  const denominator = num(windowTokens);
  if (!denominator) return null;
  return num(used) / denominator;
}

function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Start of the local day `offset` days away from the day containing `ms` (DST-safe). */
function startOfDayOffset(ms, offset) {
  const date = new Date(startOfLocalDay(ms));
  date.setDate(date.getDate() + offset);
  return date.getTime();
}

/** Contiguous local-day keys ending today, oldest first. */
function dayWindow(nowMs, count) {
  const keys = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    keys.push(localDayKey(startOfDayOffset(nowMs, -index)));
  }
  return keys;
}

/** Contiguous local-day keys from the day containing `startMs` through `nowMs`, inclusive. */
function dayKeysBetween(startMs, nowMs) {
  const keys = [];
  let cursor = startOfLocalDay(startMs);
  const last = startOfLocalDay(nowMs);
  // Bounded loop: the chart window is capped by CHART_MAX_DAYS before this is called.
  for (let index = 0; index <= CHART_MAX_DAYS + 2; index += 1) {
    keys.push(localDayKey(cursor));
    if (cursor >= last) break;
    cursor = startOfDayOffset(cursor, 1);
  }
  return keys;
}

function hitRate(cacheRead, input) {
  const denominator = cacheRead + input;
  return denominator > 0 ? cacheRead / denominator : null;
}

function normalizeRange(range) {
  return Object.prototype.hasOwnProperty.call(RANGE_DAYS, range) ? range : '7d';
}

/**
 * Range boundary in local calendar days: "7d" means today plus the previous 6 whole days, so the
 * KPI totals and the daily buckets cover exactly the same rows. `all` returns null.
 */
export function rangeToSince(range, nowMs) {
  const days = RANGE_DAYS[normalizeRange(range)];
  return days === null ? null : startOfDayOffset(nowMs, -(days - 1));
}

function filterClause(sinceMs) {
  return sinceMs === null || sinceMs === undefined
    ? { sql: '', params: [] }
    : { sql: 'WHERE ts >= ?', params: [sinceMs] };
}

function queryTotals(source, sinceMs) {
  const filter = filterClause(sinceMs);
  const rows = source.query(
    `SELECT COUNT(*) AS calls,
            COUNT(DISTINCT session_id) AS sessions,
            COUNT(DISTINCT turn_id) AS turns,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
       FROM local_runtime_token_usage ${filter.sql}`,
    filter.params,
  );
  const row = rows[0] ?? {};
  return {
    calls: num(row.calls),
    sessions: num(row.sessions),
    turns: num(row.turns),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    reasoningTokens: num(row.reasoning_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    firstTsMs: maybeNum(row.first_ts),
    lastTsMs: maybeNum(row.last_ts),
  };
}

function querySessionTotals(source, sinceMs) {
  const filter = filterClause(sinceMs);
  const rows = source.query(
    `SELECT session_id,
            COUNT(*) AS calls,
            COUNT(DISTINCT turn_id) AS turns,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts,
            MAX(agent_name) AS agent_name,
            MAX(framework_type) AS framework_type
       FROM local_runtime_token_usage ${filter.sql}
      GROUP BY session_id`,
    filter.params,
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.session_id), {
      calls: num(row.calls),
      turns: num(row.turns),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      reasoningTokens: num(row.reasoning_tokens),
      cacheReadTokens: num(row.cache_read_tokens),
      cacheWriteTokens: num(row.cache_write_tokens),
      firstTsMs: maybeNum(row.first_ts),
      lastTsMs: maybeNum(row.last_ts),
      agentName: row.agent_name ?? null,
      frameworkType: row.framework_type ?? null,
    });
  }
  return map;
}

/** Prompt size and cache share of each session's most recent model call. */
function queryLatestPrompts(source) {
  const rows = source.query(
    `SELECT session_id, ts, input_tokens, cache_read_tokens, output_tokens
       FROM local_runtime_token_usage
      WHERE id IN (SELECT MAX(id) FROM local_runtime_token_usage GROUP BY session_id)`,
  );
  const map = new Map();
  for (const row of rows) {
    const input = num(row.input_tokens);
    const cacheRead = num(row.cache_read_tokens);
    map.set(String(row.session_id), {
      tsMs: maybeNum(row.ts),
      inputTokens: input,
      cacheReadTokens: cacheRead,
      outputTokens: num(row.output_tokens),
      promptTokens: input + cacheRead,
      cacheShare: hitRate(cacheRead, input),
    });
  }
  return map;
}

/** Earliest usage record in the whole database, independent of the selected range. */
function queryHistoryFloor(source) {
  const rows = source.query('SELECT MIN(ts) AS floor FROM local_runtime_token_usage');
  return maybeNum(rows[0]?.floor);
}

function querySessionMeta(source) {
  const rows = source.query(
    `SELECT session_id, title, agent_name, workspace_dir, created_at_ms, updated_at_ms,
            status, archived, session_type, parent_session_id, session_kind
       FROM local_runtime_sessions`,
  );
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.session_id), {
      sessionId: String(row.session_id),
      title: row.title ?? null,
      agentName: row.agent_name ?? null,
      workspaceDir: row.workspace_dir ?? null,
      createdAtMs: maybeNum(row.created_at_ms),
      updatedAtMs: maybeNum(row.updated_at_ms),
      status: row.status ?? null,
      archived: num(row.archived) === 1,
      sessionType: row.session_type ?? null,
      parentSessionId: row.parent_session_id ?? null,
      sessionKind: row.session_kind ?? null,
    });
  }
  return map;
}

/** Rows for the chart and heatmap, bounded by the wider of the chart window and the heatmap. */
function queryWindowRows(source, sinceMs) {
  const rows = source.query(
    `SELECT ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM local_runtime_token_usage
      WHERE ts >= ?
      ORDER BY ts
      LIMIT ${WINDOW_ROW_LIMIT}`,
    [sinceMs],
  );
  return rows.map((row) => ({
    tsMs: num(row.ts),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
  }));
}

function buildDaily(rows, dayKeys) {
  const buckets = new Map();
  for (const key of dayKeys) {
    buckets.set(key, { date: key, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  }
  for (const row of rows) {
    const bucket = buckets.get(localDayKey(row.tsMs));
    if (!bucket) continue;
    bucket.calls += 1;
    bucket.inputTokens += row.inputTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.cacheReadTokens += row.cacheReadTokens;
  }
  return dayKeys.map((key) => {
    const bucket = buckets.get(key);
    return { ...bucket, billedTokens: bucket.inputTokens + bucket.outputTokens };
  });
}

/**
 * Chart span: exactly the selected range, or (for "all") the whole history capped at
 * CHART_MAX_DAYS so the payload stays bounded.
 */
function planChartWindow(rangeStartMs, historyFloorMs, nowMs) {
  if (rangeStartMs !== null) {
    return { startMs: rangeStartMs, dayKeys: dayKeysBetween(rangeStartMs, nowMs), coversRange: true, truncated: false };
  }
  const floor = startOfLocalDay(historyFloorMs ?? nowMs);
  const capStart = startOfDayOffset(nowMs, -(CHART_MAX_DAYS - 1));
  if (floor < capStart) {
    return { startMs: capStart, dayKeys: dayKeysBetween(capStart, nowMs), coversRange: false, truncated: true };
  }
  return { startMs: floor, dayKeys: dayKeysBetween(floor, nowMs), coversRange: true, truncated: false };
}

/* ------------------------------------------------------------------ context telemetry layer */

function snapshotFromColumns(row, sessionId) {
  const used = row.used_tokens;
  if (used === null || used === undefined) return null;
  return {
    id: num(row.id),
    sessionId,
    turnId: row.turn_id ?? null,
    tsMs: num(row.created_at_ms),
    usedTokens: num(used),
    windowTokens: maybeNum(row.window_tokens),
    countSource: row.count_source ?? null,
    model: row.model ?? null,
    divergenceRate: maybeNum(row.divergence_rate),
    calibrationStatus: row.calibration_status ?? null,
    components: [],
    componentsLoaded: false,
  };
}

/** JSON1-unsupported fallback: parse the blob the query handed back. */
function snapshotFromJson(row, sessionId) {
  let parsed;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    return null;
  }
  const usage = parsed?.context_usage;
  if (!usage || usage.usedTokens === undefined || usage.usedTokens === null) return null;
  const telemetry = parsed?.context_usage_telemetry ?? {};
  const components = Array.isArray(usage.components)
    ? usage.components
        .filter((item) => item && item.kind !== undefined)
        .map((item) => ({ kind: String(item.kind), tokens: num(item.tokens) }))
    : [];
  return {
    id: num(row.id),
    sessionId,
    turnId: row.turn_id ?? null,
    tsMs: num(row.created_at_ms),
    usedTokens: num(usage.usedTokens),
    windowTokens: maybeNum(usage.contextWindowTokens),
    countSource: usage.totalCountSource ?? null,
    model: telemetry.model ?? null,
    divergenceRate: maybeNum(telemetry.divergenceRate),
    calibrationStatus: telemetry.toolCalibrationStatus ?? null,
    components,
    componentsLoaded: true,
  };
}

/**
 * Read context snapshots for the given sessions, newest first per session, then keep those inside
 * the selected range. The per-session cap protects against a single very long session; when it is
 * hit the session id is reported so the UI can say so instead of silently showing partial data.
 */
function loadSnapshots(source, sessionIds, rangeStartMs) {
  const useJson = source.jsonSupport !== false;
  const perSession = new Map();
  const truncatedSessions = [];
  let scannedRows = 0;
  for (const sessionId of sessionIds) {
    const rows = useJson
      ? source.query(SNAPSHOT_COLUMNS_SQL, [sessionId])
      : source.query(SNAPSHOT_RAW_SQL, [sessionId]);
    scannedRows += rows.length;
    if (rows.length >= CONTEXT_SESSION_LIMIT) truncatedSessions.push(sessionId);
    const kept = [];
    for (const row of rows) {
      const snapshot = useJson ? snapshotFromColumns(row, sessionId) : snapshotFromJson(row, sessionId);
      if (!snapshot) continue;
      if (rangeStartMs !== null && snapshot.tsMs < rangeStartMs) continue;
      kept.push(snapshot);
    }
    kept.sort((left, right) => left.tsMs - right.tsMs || left.id - right.id);
    perSession.set(sessionId, kept);
  }
  return { perSession, truncatedSessions, useJson, scannedRows };
}

/** Expand the component list of specific snapshot rows (one batched query per id chunk). */
function loadComponents(source, snapshotIds) {
  const map = new Map();
  if (!snapshotIds.length) return map;
  for (let start = 0; start < snapshotIds.length; start += ID_CHUNK) {
    const chunk = snapshotIds.slice(start, start + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = source.query(
      `SELECT m.id AS id,
              json_extract(c.value, '$.kind') AS kind,
              json_extract(c.value, '$.tokens') AS tokens
         FROM local_runtime_message_rows m,
              json_each(m.data_json, '$.context_usage.components') c
        WHERE m.id IN (${placeholders})`,
      chunk,
    );
    for (const row of rows) {
      const id = num(row.id);
      const list = map.get(id) ?? [];
      if (row.kind !== null && row.kind !== undefined) {
        list.push({ kind: String(row.kind), tokens: num(row.tokens) });
      }
      map.set(id, list);
    }
  }
  return map;
}

function withShares(components, total) {
  const sorted = [...components].sort(
    (left, right) => COMPONENT_ORDER.indexOf(left.kind) - COMPONENT_ORDER.indexOf(right.kind),
  );
  return sorted.map((item) => ({
    kind: item.kind,
    label: COMPONENT_LABELS[item.kind] ?? item.kind,
    tokens: item.tokens,
    share: total > 0 ? item.tokens / total : null,
  }));
}

function mergeComponents(snapshots) {
  const totals = new Map();
  for (const snapshot of snapshots) {
    for (const item of snapshot.components ?? []) {
      totals.set(item.kind, (totals.get(item.kind) ?? 0) + item.tokens);
    }
  }
  const sum = [...totals.values()].reduce((acc, value) => acc + value, 0);
  return withShares([...totals.entries()].map(([kind, tokens]) => ({ kind, tokens })), sum);
}

function emptyContext(reason) {
  return {
    available: false,
    degradedReason: reason,
    componentsLoaded: false,
    samples: 0,
    sessions: 0,
    latestAtMs: null,
    global: {
      usedTokens: 0,
      windowTokens: 0,
      ratio: null,
      avgRatio: null,
      peakUsedTokens: 0,
      components: [],
    },
    perSession: {},
    truncatedSessions: [],
  };
}

/**
 * Build the context report. Never throws: any failure degrades to `available: false` so the token
 * panels keep working.
 */
function buildContextReport(source, rangeStartMs, sessionTotals) {
  const sessionIds = [...sessionTotals.keys()];
  const { perSession, truncatedSessions, useJson, scannedRows } = loadSnapshots(
    source,
    sessionIds,
    rangeStartMs,
  );

  // No telemetry row at all on these sessions: this runtime does not write `context_usage`, so the
  // context layer is unavailable rather than merely empty for the selected range.
  if (scannedRows === 0) {
    return {
      payload: emptyContext('这些会话的模型调用里没有上下文遥测记录（该运行时可能未写入 context_usage）'),
      snapshots: [],
    };
  }

  const allSnapshots = [];
  const latestSnapshots = [];
  const latestBySession = new Map();
  for (const [sessionId, list] of perSession) {
    for (const snapshot of list) allSnapshots.push(snapshot);
    if (!list.length) continue;
    const latest = list[list.length - 1];
    const peak = list.reduce((best, item) => (item.usedTokens > best.usedTokens ? item : best), list[0]);
    latestSnapshots.push(latest);
    latestBySession.set(sessionId, { latest, peak, count: list.length });
  }

  if (useJson && latestSnapshots.length) {
    const components = loadComponents(source, latestSnapshots.map((snapshot) => snapshot.id));
    for (const snapshot of latestSnapshots) {
      snapshot.components = components.get(snapshot.id) ?? [];
      snapshot.componentsLoaded = true;
    }
  }

  const perSessionOut = {};
  for (const [sessionId, entry] of latestBySession) {
    const { latest, peak, count } = entry;
    perSessionOut[sessionId] = {
      tsMs: latest.tsMs,
      usedTokens: latest.usedTokens,
      windowTokens: latest.windowTokens,
      ratio: ratioOf(latest.usedTokens, latest.windowTokens),
      peakUsedTokens: peak.usedTokens,
      peakTsMs: peak.tsMs,
      peakRatio: ratioOf(peak.usedTokens, peak.windowTokens),
      components: withShares(latest.components ?? [], latest.usedTokens),
      componentsLoaded: Boolean(latest.componentsLoaded),
      model: latest.model,
      divergenceRate: latest.divergenceRate,
      calibrationStatus: latest.calibrationStatus,
      samples: count,
    };
  }

  const globalUsed = latestSnapshots.reduce((sum, snapshot) => sum + snapshot.usedTokens, 0);
  const globalWindow = latestSnapshots.reduce((sum, snapshot) => sum + num(snapshot.windowTokens), 0);
  const ratios = latestSnapshots
    .map((snapshot) => ratioOf(snapshot.usedTokens, snapshot.windowTokens))
    .filter((value) => value !== null);
  const latestTs = latestSnapshots.reduce((best, snapshot) => Math.max(best, snapshot.tsMs), 0);

  return {
    payload: {
      available: true,
      degradedReason: null,
      componentsLoaded: useJson || latestSnapshots.every((snapshot) => snapshot.componentsLoaded),
      samples: allSnapshots.length,
      sessions: latestSnapshots.length,
      latestAtMs: latestTs || null,
      global: {
        usedTokens: globalUsed,
        windowTokens: globalWindow,
        ratio: ratioOf(globalUsed, globalWindow),
        avgRatio: ratios.length ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : null,
        peakUsedTokens: latestSnapshots.reduce((best, snapshot) => Math.max(best, snapshot.usedTokens), 0),
        components: mergeComponents(latestSnapshots),
      },
      perSession: perSessionOut,
      truncatedSessions,
    },
    snapshots: allSnapshots,
  };
}

/* ------------------------------------------------------------------------- model statistics */

/**
 * Attribute token rows to the model that produced them. The usage table's own `model` column is
 * NULL in this runtime, so the model comes from the per-call telemetry and is joined on `turn_id`
 * (one model per turn, verified: no turn mixes models). The model name is not available for calls
 * whose turn has no telemetry; those fall into an explicit "unknown" bucket.
 */
function buildModelStats(source, rangeStartMs, snapshots) {
  const filter = filterClause(rangeStartMs);
  const rows = source.query(
    `SELECT turn_id, input_tokens, output_tokens, cache_read_tokens
       FROM local_runtime_token_usage ${filter.sql}
      LIMIT ${WINDOW_ROW_LIMIT}`,
    filter.params,
  );

  const modelByTurn = new Map();
  const stats = new Map();
  const ensure = (model) => {
    let entry = stats.get(model);
    if (!entry) {
      entry = {
        model,
        shortName: model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model,
        calls: 0,
        sessions: new Set(),
        usageRows: 0,
        windowTokens: 0,
        peakUsedTokens: 0,
        usedSum: 0,
        usedCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        calibration: {},
      };
      stats.set(model, entry);
    }
    return entry;
  };

  for (const snapshot of snapshots) {
    const model = snapshot.model && String(snapshot.model).trim() ? String(snapshot.model) : UNKNOWN_MODEL;
    if (snapshot.turnId && !modelByTurn.has(snapshot.turnId)) modelByTurn.set(snapshot.turnId, model);
    const entry = ensure(model);
    entry.calls += 1;
    entry.sessions.add(snapshot.sessionId);
    entry.windowTokens = Math.max(entry.windowTokens, num(snapshot.windowTokens));
    entry.peakUsedTokens = Math.max(entry.peakUsedTokens, snapshot.usedTokens);
    entry.usedSum += snapshot.usedTokens;
    entry.usedCount += 1;
    const calibration = snapshot.calibrationStatus ?? 'UNKNOWN';
    entry.calibration[calibration] = (entry.calibration[calibration] ?? 0) + 1;
  }

  for (const row of rows) {
    const model = modelByTurn.get(String(row.turn_id)) ?? UNKNOWN_MODEL;
    const entry = ensure(model);
    entry.usageRows += 1;
    entry.inputTokens += num(row.input_tokens);
    entry.outputTokens += num(row.output_tokens);
    entry.cacheReadTokens += num(row.cache_read_tokens);
  }

  return [...stats.values()]
    .map((entry) => ({
      model: entry.model,
      shortName: entry.shortName,
      calls: entry.calls,
      // A bucket with no telemetry snapshots only carries token rows whose turn had no context
      // telemetry; the UI must not present it as "0 calls of a model".
      telemetryMissing: entry.calls === 0,
      sessions: entry.sessions.size,
      usageRows: entry.usageRows,
      windowTokens: entry.windowTokens || null,
      peakUsedTokens: entry.peakUsedTokens,
      peakRatio: ratioOf(entry.peakUsedTokens, entry.windowTokens),
      avgUsedTokens: entry.usedCount ? Math.round(entry.usedSum / entry.usedCount) : null,
      avgRatio: entry.windowTokens ? entry.usedSum / entry.usedCount / entry.windowTokens : null,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      billedTokens: entry.inputTokens + entry.outputTokens,
      cacheHitRate: hitRate(entry.cacheReadTokens, entry.inputTokens),
      calibration: entry.calibration,
    }))
    .sort((left, right) => right.calls - left.calls || right.billedTokens - left.billedTokens);
}

/* ------------------------------------------------------------------------------- overview */

export function buildOverview(source, range, nowMs) {
  const startedAt = Date.now();
  const timings = {};
  const normalized = normalizeRange(range);
  const rangeStartMs = rangeToSince(normalized, nowMs);

  let mark = Date.now();
  const totals = queryTotals(source, rangeStartMs);
  const historyFloorMs = queryHistoryFloor(source);
  timings.totalsMs = Date.now() - mark;

  mark = Date.now();
  const sessionTotals = querySessionTotals(source, rangeStartMs);
  const latestPrompts = queryLatestPrompts(source);
  const sessionMeta = querySessionMeta(source);
  timings.sessionsMs = Date.now() - mark;

  const chartPlan = planChartWindow(rangeStartMs, historyFloorMs, nowMs);
  const heatKeys = dayWindow(nowMs, HEATMAP_DAYS);
  const heatStartMs = startOfDayOffset(nowMs, -(HEATMAP_DAYS - 1));
  const windowSince = Math.min(chartPlan.startMs, heatStartMs);

  mark = Date.now();
  const windowRows = queryWindowRows(source, windowSince);
  const heatmap = buildDaily(windowRows, heatKeys);
  const daily = buildDaily(windowRows, chartPlan.dayKeys);
  timings.windowMs = Date.now() - mark;

  mark = Date.now();
  let context;
  let snapshots = [];
  try {
    const built = buildContextReport(source, rangeStartMs, sessionTotals);
    context = built.payload;
    snapshots = built.snapshots;
  } catch (error) {
    context = emptyContext(describe(error));
  }
  timings.contextMs = Date.now() - mark;

  mark = Date.now();
  let models = [];
  try {
    // Without any context telemetry the model dimension has no source at all; showing a single
    // "unattributed" bucket holding every token would misrepresent the data.
    if (context.available) models = buildModelStats(source, rangeStartMs, snapshots);
  } catch {
    models = [];
  }
  timings.modelsMs = Date.now() - mark;

  const sessions = [];
  for (const [sessionId, stats] of sessionTotals) {
    const meta = sessionMeta.get(sessionId) ?? {};
    const latest = latestPrompts.get(sessionId) ?? null;
    sessions.push({
      sessionId,
      title: meta.title ?? null,
      workspaceDir: meta.workspaceDir ?? null,
      agentName: stats.agentName ?? meta.agentName ?? null,
      frameworkType: stats.frameworkType ?? null,
      createdAtMs: meta.createdAtMs ?? null,
      status: meta.status ?? null,
      archived: meta.archived ?? false,
      sessionType: meta.sessionType ?? null,
      calls: stats.calls,
      turns: stats.turns,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      reasoningTokens: stats.reasoningTokens,
      cacheReadTokens: stats.cacheReadTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      billedTokens: stats.inputTokens + stats.outputTokens,
      cacheHitRate: hitRate(stats.cacheReadTokens, stats.inputTokens),
      firstTsMs: stats.firstTsMs,
      lastTsMs: stats.lastTsMs,
      latestPrompt: latest,
      metaKnown: Boolean(meta.sessionId),
    });
  }
  sessions.sort((left, right) => (right.lastTsMs ?? 0) - (left.lastTsMs ?? 0));

  const cachedSessions = new Set(sessionTotals.keys());
  let untracked = 0;
  for (const sessionId of sessionMeta.keys()) {
    if (!cachedSessions.has(sessionId)) untracked += 1;
  }

  const kpiBilled = totals.inputTokens + totals.outputTokens;
  const chartCalls = daily.reduce((sum, day) => sum + day.calls, 0);
  const chartBilled = daily.reduce((sum, day) => sum + day.billedTokens, 0);
  const invariantViolated = chartPlan.coversRange && (chartCalls !== totals.calls || chartBilled !== kpiBilled);

  timings.totalMs = Date.now() - startedAt;

  return {
    generatedAtMs: nowMs,
    range: normalized,
    chartDays: daily.length,
    heatmapDays: HEATMAP_DAYS,
    kpi: {
      sessions: totals.sessions,
      calls: totals.calls,
      turns: totals.turns,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      reasoningTokens: totals.reasoningTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      billedTokens: totals.inputTokens + totals.outputTokens,
      cacheHitRate: hitRate(totals.cacheReadTokens, totals.inputTokens),
      firstTsMs: totals.firstTsMs,
      lastTsMs: totals.lastTsMs,
    },
    daily,
    heatmap,
    sessions,
    context,
    models,
    coverage: {
      totalSessionsKnown: sessionMeta.size,
      sessionsWithoutUsage: untracked,
      historyFloorMs,
      chartCoversRange: chartPlan.coversRange,
      chartTruncated: chartPlan.truncated,
      chartCalls,
      invariantViolated,
      windowRowsTruncated: windowRows.length >= WINDOW_ROW_LIMIT,
      jsonSupport: source.jsonSupport !== false,
      snapshots: context.samples ?? 0,
      snapshotSessions: context.sessions ?? 0,
      truncatedSessions: context.truncatedSessions ?? [],
    },
    timings,
  };
}

/* ------------------------------------------------------------------------- session detail */

function downsample(list, max) {
  if (list.length <= max) return list;
  const step = (list.length - 1) / (max - 1);
  const out = [];
  let lastIndex = -1;
  for (let index = 0; index < max; index += 1) {
    const source = Math.round(index * step);
    if (source === lastIndex) continue;
    lastIndex = source;
    out.push(list[source]);
  }
  return out;
}

/**
 * One page of a session's model calls plus that session's context growth.
 * `totals` always covers the whole session, never just the returned page.
 */
export function buildSessionDetail(source, sessionId, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DETAIL_PAGE_DEFAULT) || DETAIL_PAGE_DEFAULT, 1), DETAIL_PAGE_MAX);
  const meta = querySessionMeta(source).get(sessionId) ?? null;

  const totalsRows = source.query(
    `SELECT COUNT(*) AS calls,
            COUNT(DISTINCT turn_id) AS turns,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
       FROM local_runtime_token_usage
      WHERE session_id = ?`,
    [sessionId],
  );
  const totalsRow = totalsRows[0] ?? {};
  const totalCalls = num(totalsRow.calls);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0) || 0, 0), Math.max(totalCalls - 1, 0));

  const rows = source.query(
    `SELECT ${TOKEN_PAGE_COLUMNS}
       FROM local_runtime_token_usage
      WHERE session_id = ?
      ORDER BY ts, id
      LIMIT ${limit} OFFSET ${offset}`,
    [sessionId],
  );

  const calls = rows.map((row) => {
    const input = num(row.input_tokens);
    const output = num(row.output_tokens);
    const cacheRead = num(row.cache_read_tokens);
    return {
      id: num(row.id),
      turnId: row.turn_id ?? null,
      tsMs: num(row.ts),
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: num(row.reasoning_tokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: num(row.cache_write_tokens),
      promptTokens: input + cacheRead,
      billedTokens: input + output,
      cacheHitRate: hitRate(cacheRead, input),
      agentName: row.agent_name ?? null,
      frameworkType: row.framework_type ?? null,
    };
  });

  const detailContext = (reason) => ({
    ...emptyContext(reason),
    latest: null,
    peak: null,
    series: [],
    seriesDownsampled: false,
    truncated: false,
  });

  let context = detailContext(null);
  try {
    const rangeStartMs = rangeToSince(options.range ?? 'all', nowMs);
    const { perSession, truncatedSessions, useJson, scannedRows } = loadSnapshots(
      source,
      [sessionId],
      rangeStartMs,
    );
    const list = perSession.get(sessionId) ?? [];
    if (!list.length && scannedRows === 0) {
      context = detailContext('该会话的模型调用里没有上下文遥测记录');
    } else if (list.length) {
      const latest = list[list.length - 1];
      if (useJson) {
        const components = loadComponents(source, [latest.id]);
        latest.components = components.get(latest.id) ?? [];
        latest.componentsLoaded = true;
      }
      const series = downsample(
        list.map((snapshot) => ({ tsMs: snapshot.tsMs, usedTokens: snapshot.usedTokens, windowTokens: snapshot.windowTokens })),
        SERIES_MAX_POINTS,
      );
      const peak = list.reduce((best, item) => (item.usedTokens > best.usedTokens ? item : best), list[0]);
      context = {
        available: true,
        degradedReason: null,
        latest: {
          tsMs: latest.tsMs,
          usedTokens: latest.usedTokens,
          windowTokens: latest.windowTokens,
          ratio: ratioOf(latest.usedTokens, latest.windowTokens),
          components: withShares(latest.components ?? [], latest.usedTokens),
          model: latest.model,
          divergenceRate: latest.divergenceRate,
          calibrationStatus: latest.calibrationStatus,
          countSource: latest.countSource,
        },
        peak: {
          tsMs: peak.tsMs,
          usedTokens: peak.usedTokens,
          windowTokens: peak.windowTokens,
          ratio: ratioOf(peak.usedTokens, peak.windowTokens),
        },
        series,
        samples: list.length,
        seriesDownsampled: series.length < list.length,
        truncated: truncatedSessions.includes(sessionId),
      };
    }
  } catch (error) {
    context = { ...context, available: false, degradedReason: describe(error) };
  }

  return {
    sessionId,
    meta,
    totals: {
      calls: totalCalls,
      turns: num(totalsRow.turns),
      inputTokens: num(totalsRow.input_tokens),
      outputTokens: num(totalsRow.output_tokens),
      reasoningTokens: num(totalsRow.reasoning_tokens),
      cacheReadTokens: num(totalsRow.cache_read_tokens),
      cacheWriteTokens: num(totalsRow.cache_write_tokens),
      billedTokens: num(totalsRow.input_tokens) + num(totalsRow.output_tokens),
      cacheHitRate: hitRate(num(totalsRow.cache_read_tokens), num(totalsRow.input_tokens)),
      firstTsMs: maybeNum(totalsRow.first_ts),
      lastTsMs: maybeNum(totalsRow.last_ts),
    },
    page: {
      limit,
      offset,
      returned: calls.length,
      total: totalCalls,
      hasMore: offset + calls.length < totalCalls,
    },
    calls,
    context,
  };
}
