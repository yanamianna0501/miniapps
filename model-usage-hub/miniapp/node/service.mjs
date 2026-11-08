import { readConfig, openUsage } from './source.mjs';
import { buildOverview, rangeToSince } from './usage-report.mjs';
import { queryQuota } from './quota.mjs';
import { getProxyStatus, executeProxyControl } from './proxy-controller.mjs';

export const ranges = new Set(['7d', '30d', 'all']);
const n = x => Number(x) || 0;
export function usageByModel(source, range, nowMs) {
  const since = rangeToSince(range, nowMs);
  const rows = source.query(`SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens,
    SUM(output_tokens) AS outputTokens, SUM(cache_read_tokens) AS cacheReadTokens
    FROM local_runtime_token_usage ${since === null ? '' : 'WHERE ts >= ?'} GROUP BY model`, since === null ? [] : [since]);
  return rows.map(row => ({ model: row.model || null, calls: n(row.calls), inputTokens: n(row.inputTokens),
    outputTokens: n(row.outputTokens), cacheReadTokens: n(row.cacheReadTokens),
    billedTokens: n(row.inputTokens) + n(row.outputTokens),
    cacheHitRate: n(row.inputTokens) + n(row.cacheReadTokens) > 0 ? n(row.cacheReadTokens) / (n(row.inputTokens) + n(row.cacheReadTokens)) : null }));
}
export function attachUsage(providers, rows) {
  const matched = new Set();
  const map = new Map(rows.filter(x => x.model).map(x => [x.model, x]));
  const safe = providers.map(p => ({ id: p.id, name: p.name, enabled: p.enabled,
    models: p.models.map(model => {
      // Only fully-qualified model ids prove provider attribution; no name-only allocation.
      const keys = [`custom_provider:${p.id}/${model.id}`, `${p.id}/${model.id}`];
      const found = keys.map(key => map.get(key)).filter(Boolean);
      for (const item of found) matched.add(item.model);
      const usage = found.length ? found.reduce((a, item) => ({ calls: a.calls + item.calls,
        inputTokens: a.inputTokens + item.inputTokens, outputTokens: a.outputTokens + item.outputTokens,
        cacheReadTokens: a.cacheReadTokens + item.cacheReadTokens, billedTokens: a.billedTokens + item.billedTokens }),
      { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, billedTokens: 0 }) : null;
      if (usage) usage.cacheHitRate = usage.inputTokens + usage.cacheReadTokens > 0 ? usage.cacheReadTokens / (usage.inputTokens + usage.cacheReadTokens) : null;
      return { ...model, localUsage: usage, localUsageStatus: usage ? 'exact' : 'none' };
    }) }));
  return { providers: safe, unassignedCalls: rows.filter(x => !matched.has(x.model)).reduce((sum, x) => sum + x.calls, 0) };
}
function removePrivateFields(payload) {
  delete payload.sessions;
  delete payload.context?.perSession;
  if (payload.context?.degradedReason) payload.context.degradedReason = '上下文遥测暂不可用，Token 总计仍来自真实用量记录';
  delete payload.context?.truncatedSessions;
  if (payload.coverage) delete payload.coverage.truncatedSessions;
  return payload;
}
export function createService(root, signal, children) {
  let usageCache = new Map();
  const quotaCache = new Map();
  const quotaPending = new Map();
  let providersPending = null;
  let overviewPending = new Map();
  const inUsage = async work => {
    const source = openUsage(root);
    try { return work(source); } finally { source.close(); }
  };
  async function overview(range) {
    const cached = usageCache.get(range);
    if (cached && Date.now() - cached.generatedAtMs < 10000) return cached;
    if (overviewPending.has(range)) return overviewPending.get(range);
    const pending = inUsage(s => {
      const data = removePrivateFields(buildOverview(s, range, Date.now()));
      data.accountingNote = '输入 + 输出为本机统计量，不是账单金额；缓存读取单列。本机记录不涵盖其他设备。';
      data.attribution = { qualifiedCalls: usageByModel(s, range, data.generatedAtMs).filter(x => x.model).reduce((sum, x) => sum + x.calls, 0) };
      usageCache.set(range, data);
      return data;
    }).finally(() => overviewPending.delete(range));
    overviewPending.set(range, pending);
    return pending;
  }
  async function config() {
    if (providersPending) return providersPending;
    providersPending = readConfig(root, signal, children).finally(() => { providersPending = null; });
    return providersPending;
  }
  async function quota(p, force) {
    // Model and account changes invalidate cached quota without logging or hashing credentials.
    const old = quotaCache.get(p.id);
    const sameConfig = old?.key === p.apiKey && old?.url === p.baseURL && old?.enabled === p.enabled;
    const maxAge = force ? 20000 : 5 * 60000;
    if (sameConfig && Date.now() - old.data.asOfMs < maxAge) return old.data;
    const flightKey = `${p.id}|${p.baseURL}|${p.apiKey}|${p.enabled}`;
    if (quotaPending.has(flightKey)) return quotaPending.get(flightKey);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(22000)]);
    const pending = queryQuota(p, root, timeout).catch(() => ({ status: 'error', source: '服务商查询', message: '查询超时或已取消，请稍后刷新', asOfMs: Date.now(), windows: [], balances: [] }))
      .then(data => { quotaCache.set(p.id, { data, key: p.apiKey, url: p.baseURL, enabled: p.enabled }); return data; })
      .finally(() => quotaPending.delete(flightKey));
    quotaPending.set(flightKey, pending);
    return pending;
  }
  async function providers(range, force = false) {
    const configs = await config();
    const queries = configs.map(p => quota(p, force));
    const proxyQueries = configs.map(p => getProxyStatus(p.id));
    let attribution;
    let usageStatus = 'ok';
    try { attribution = await inUsage(s => attachUsage(configs, usageByModel(s, range, Date.now()))); }
    catch { usageStatus = 'error'; attribution = attachUsage(configs, []); }
    const [quotas, proxies] = await Promise.all([Promise.all(queries), Promise.all(proxyQueries)]);
    return { generatedAtMs: Date.now(), range, localUsageStatus: usageStatus, unassignedCalls: attribution.unassignedCalls,
      providers: attribution.providers.map((p, i) => ({ ...p, quota: quotas[i], proxy: proxies[i] })) };
  }
  async function controlProxy(id, action) {
    const res = await executeProxyControl(id, action);
    quotaCache.delete(id);
    return res;
  }
  return { overview, providers, controlProxy, clear: () => { usageCache.clear(); quotaCache.clear(); } };
}
