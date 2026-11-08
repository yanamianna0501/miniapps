import { getJson, postJson } from './http-client.mjs';
import { readCodex, readGoogleAntigravity, DataError } from './source.mjs';

const finite = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const quotaBase = (source, status, message) => ({ source, status, message, asOfMs: Date.now(), windows: [], balances: [] });
function requireShape(test) { if (!test) throw new DataError('quota_shape', '额度接口返回的字段不完整，未将缺失数据当成 0'); }
export function parseDeepseek(data) {
  requireShape(typeof data?.is_available === 'boolean' && Array.isArray(data.balance_infos) && data.balance_infos.length > 0);
  const balances = data.balance_infos.map(row => {
    requireShape(typeof row.currency === 'string' && finite(row.total_balance));
    return { currency: row.currency, remaining: Number(row.total_balance) };
  });
  return { ...quotaBase('DeepSeek 官方余额接口', 'ok', data.is_available ? '账户共享余额，不按模型拆分' : '账户当前没有可用余额'), balances };
}
export function parseCodex(data) {
  requireShape(data?.rate_limit && typeof data.rate_limit === 'object');
  const windows = [];
  for (const [id, label] of [['primary_window', '短时窗口'], ['secondary_window', '周窗口']]) {
    const row = data.rate_limit[id];
    if (row === null || row === undefined) continue;
    requireShape(typeof row === 'object' && finite(row.used_percent));
    const used = Number(row.used_percent);
    requireShape(used >= 0 && used <= 100);
    windows.push({ id, label, usedPercent: used, remainingPercent: 100 - used,
      resetAt: finite(row.reset_at) ? Number(row.reset_at) * 1000 : null,
      windowSeconds: finite(row.limit_window_seconds) ? Number(row.limit_window_seconds) : null });
  }
  requireShape(windows.length > 0);
  const balances = finite(data.credits?.balance) ? [{ currency: 'Credits', remaining: Number(data.credits.balance) }] : [];
  return { ...quotaBase('Codex 订阅实时接口', 'ok', '同一账户的共享额度；不是每个模型独立的额度'),
    plan: typeof data.plan_type === 'string' ? data.plan_type : undefined,
    windows, balances, details: data.rate_limit.limit_reached ? ['账户已触及额度限制'] : [] };
}
export function parseGoogleAntigravity(summaryData, modelsData) {
  requireShape(summaryData && typeof summaryData === 'object');
  const windows = [];
  const groups = Array.isArray(summaryData.groups) ? summaryData.groups : [];
  for (const group of groups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    for (const b of buckets) {
      if (!b || typeof b !== 'object') continue;
      const rf = Number(b.remainingFraction);
      if (!Number.isFinite(rf) || rf < 0 || rf > 1) continue;
      const remPct = Math.round(rf * 1000) / 10;
      const usedPct = Math.round((1 - rf) * 1000) / 10;
      const resetAt = b.resetTime ? Date.parse(b.resetTime) : null;
      let label = b.displayName || b.bucketId;
      if (b.bucketId === '3p-weekly' || (b.window === 'weekly' && String(group.displayName).includes('Claude'))) {
        label = 'Claude/GPT 周额度';
      } else if (b.bucketId === '3p-5h' || (b.window === '5h' && String(group.displayName).includes('Claude'))) {
        label = 'Claude/GPT 5小时窗口';
      } else if (b.bucketId === 'gemini-weekly' || (b.window === 'weekly' && String(group.displayName).includes('Gemini'))) {
        label = 'Gemini 周额度';
      } else if (b.bucketId === 'gemini-5h' || (b.window === '5h' && String(group.displayName).includes('Gemini'))) {
        label = 'Gemini 5小时窗口';
      }
      windows.push({
        id: b.bucketId || `google-${windows.length}`,
        label,
        remainingPercent: remPct,
        usedPercent: usedPct,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
      });
    }
  }

  const hasGeminiWindow = windows.some(w => String(w.id).includes('gemini'));
  if (!hasGeminiWindow && modelsData && typeof modelsData === 'object' && modelsData.models) {
    const geminiFractions = [];
    let geminiReset = null;
    for (const [id, m] of Object.entries(modelsData.models)) {
      if (id.includes('gemini') && m?.quotaInfo && Number.isFinite(Number(m.quotaInfo.remainingFraction))) {
        const f = Number(m.quotaInfo.remainingFraction);
        if (f >= 0 && f <= 1) {
          geminiFractions.push(f);
          if (!geminiReset && m.quotaInfo.resetTime) {
            const parsed = Date.parse(m.quotaInfo.resetTime);
            if (Number.isFinite(parsed)) geminiReset = parsed;
          }
        }
      }
    }
    if (geminiFractions.length > 0) {
      const minFraction = Math.min(...geminiFractions);
      const remPct = Math.round(minFraction * 1000) / 10;
      windows.push({
        id: 'google-gemini-quota',
        label: 'Gemini 5小时窗口',
        remainingPercent: remPct,
        usedPercent: Math.round((1 - minFraction) * 1000) / 10,
        resetAt: geminiReset,
      });
    }
  }

  requireShape(windows.length > 0);
  return {
    ...quotaBase('Google 官方 Antigravity 接口', 'ok', 'Google AI Pro 账号共享配额（含 Gemini 与 Claude 双周额度）'),
    windows,
    balances: [],
    details: [
      'Gemini 系列模型与 Claude / GPT 模型分属不同共享额度组',
      '两组均包含 7 天周额度（每周硬上限）与 5 小时滚动平滑窗口',
    ],
  };
}
async function request(url, headers, signal) {
  const result = await getJson(url, { Accept: 'application/json', ...headers }, signal);
  if (result.status === 401 || result.status === 403) throw new DataError('quota_auth', '查询未获授权，请重新登录或补充账单/管理查询授权');
  if (result.status === 429) throw new DataError('quota_rate_limit', '查询过于频繁，请稍后刷新');
  if (result.status !== 200) throw new DataError('quota_http', `额度查询返回 HTTP ${result.status}`);
  try { return JSON.parse(result.body); }
  catch { throw new DataError('quota_shape', '额度接口未返回有效 JSON'); }
}
function correctHost(provider, expected) {
  try { return new URL(provider.baseURL).hostname === expected; } catch { return false; }
}
export async function queryQuota(provider, root, signal) {
  const p = provider;
  if (!p.enabled) return quotaBase('本机配置', 'unsupported', '该服务商已停用，未向账户发起查询');
  try {
    if (p.id === 'deepseek' && correctHost(p, 'api.deepseek.com')) {
      if (!p.apiKey) return quotaBase('DeepSeek', 'auth_required', '未配置余额查询所需的 API 密钥');
      return parseDeepseek(await request('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${p.apiKey}` }, signal));
    }
    if (p.id === 'openai-codex' && correctHost(p, 'chatgpt.com')) {
      const auth = await readCodex(root);
      return parseCodex(await request('https://chatgpt.com/backend-api/wham/usage', {
        Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-ID': auth.accountId,
        'User-Agent': 'mcode-miniapp/model-usage-hub',
      }, signal));
    }
    if (p.id === 'google-pro-local') {
      const auth = await readGoogleAntigravity(root);
      const postHeaders = {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'antigravity/2.25.0 windows/amd64',
        'X-Goog-Api-Client': 'gl-go antigravity/2.25.0',
      };
      const postBody = JSON.stringify({ project: auth.projectId || 'aicode-consumers' });
      const primaryUrl = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
      const fallbackUrl = `${auth.endpoint}/v1internal:retrieveUserQuotaSummary`;
      const modelsUrl = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';

      let summaryRes = await postJson(primaryUrl, postHeaders, postBody, signal).catch(() => null);
      if (!summaryRes || summaryRes.status !== 200) {
        summaryRes = await postJson(fallbackUrl, postHeaders, postBody, signal).catch(err => {
          if (err instanceof DataError) throw err;
          return { status: 500, body: '' };
        });
      }
      const modelsRes = await postJson(modelsUrl, postHeaders, postBody, signal).catch(() => ({ status: 500, body: '' }));

      if (summaryRes.status === 401 || summaryRes.status === 403) {
        throw new DataError('antigravity_auth_expired', 'Google Antigravity 登录凭据已失效或过期，请重新登录');
      }
      if (summaryRes.status !== 200 && modelsRes.status !== 200) {
        throw new DataError('antigravity_http', `Google 配额接口请求失败（HTTP ${summaryRes.status}）`);
      }

      let summaryJson = null;
      let modelsJson = null;
      try { if (summaryRes.status === 200) summaryJson = JSON.parse(summaryRes.body); } catch {}
      try { if (modelsRes.status === 200) modelsJson = JSON.parse(modelsRes.body); } catch {}

      return parseGoogleAntigravity(summaryJson, modelsJson);
    }
    if (p.id === 'workbuddy-local') {
      const base = new URL(p.baseURL);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return quotaBase('WorkBuddy 代理', 'unsupported', '未验证当前代理的积分查询接口');
      const r = await getJson(new URL('/health', base).href, { Accept: 'application/json' }, signal);
      if (r.status !== 200) throw new DataError('proxy_unavailable', 'WorkBuddy 本地代理当前不可用');
      return quotaBase('WorkBuddy 本地代理', 'unsupported', '代理服务可用；当前未接入账户积分查询，不代表积分为 0');
    }
    if (p.id === 'mimo') return quotaBase('MiMo', 'auth_required', '当前模型 API 密钥不足以读取控制台余额；尚缺控制台查询授权');
    if (p.id === 'qwen-bailian') return quotaBase('阿里云百炼', 'auth_required', '当前仅配置模型调用密钥；尚缺费用/账单查询授权');
    if (p.id === 'minimax') return quotaBase('MiniMax 内置账户', 'unsupported', '内置账户额度未接入此应用，请在 MCode 账户页查看；本机用量可查');
    return quotaBase('当前服务商', 'unsupported', '尚未验证该服务商的账户额度接口；本机用量仍可查询');
  } catch (error) {
    if (signal?.aborted) throw error;
    const safe = error instanceof DataError ? error.message : '额度查询连接失败，请检查网络或代理';
    return quotaBase('服务商账户查询', ['quota_auth', 'codex_auth_missing', 'antigravity_auth_missing', 'antigravity_auth_expired'].includes(error.code) ? 'auth_required' : 'error', safe);
  }
}
