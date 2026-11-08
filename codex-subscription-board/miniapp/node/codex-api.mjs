// @ts-check
/**
 * Read-only ChatGPT/Codex subscription probes.
 * Both endpoints are the ones the official Codex client uses; nothing here writes
 * to the account or to the credential files.
 */

import { getJson } from './http-client.mjs';

const BASE = 'https://chatgpt.com/backend-api';
const CLIENT_VERSION = '0.160.0';

/** @typedef {{ accessToken: string, accountId: string, source: string, expiresAt: number | null }} Credentials */

/** A failure the page can explain to the user without leaking internals. */
export class CodexError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
    this.status = extra.status ?? null;
    this.retryable = extra.retryable ?? false;
  }
}

/**
 * @param {string} path
 * @param {Credentials} creds
 * @param {AbortSignal} [signal]
 */
async function request(path, creds, signal) {
  let result;
  try {
    result = await getJson(
      BASE + path,
      {
        Authorization: `Bearer ${creds.accessToken}`,
        'ChatGPT-Account-ID': creds.accountId,
        'User-Agent': 'mcode-miniapp/codex-subscription-board',
        Accept: 'application/json',
      },
      signal
    );
  } catch (error) {
    if (signal?.aborted) throw new CodexError('aborted', '请求已取消');
    if (error?.code === 'PROXY_REJECTED') {
      throw new CodexError('proxy_error', '本机代理拒绝了连接，请检查代理是否在运行');
    }
    if (error?.code === 'BODY_TOO_LARGE') {
      throw new CodexError('bad_payload', 'ChatGPT 返回的内容过大');
    }
    throw new CodexError('network', '连不上 ChatGPT 服务，请检查网络或代理', { retryable: true });
  }

  const { status, body } = result;

  if (status === 401 || status === 403) {
    throw new CodexError('unauthorized', '登录已失效或过期，请在 Codex CLI 或 MiniMax Code 里重新登录', {
      status,
    });
  }
  if (status === 429) {
    throw new CodexError('rate_limited', '请求太频繁，稍后再试', { status, retryable: true });
  }
  if (status < 200 || status >= 300) {
    throw new CodexError('http_error', `ChatGPT 返回 ${status}`, {
      status,
      retryable: status >= 500,
    });
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new CodexError('bad_payload', 'ChatGPT 返回了无法解析的内容');
  }
}

/** @param {any} window */
function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const used = Number(window.used_percent);
  const span = Number(window.limit_window_seconds);
  const resetAt = Number(window.reset_at);
  const resetAfter = Number(window.reset_after_seconds);
  if (!Number.isFinite(used)) return null;
  return {
    usedPercent: clampPercent(used),
    remainingPercent: clampPercent(100 - used),
    windowSeconds: Number.isFinite(span) ? span : null,
    resetAt: Number.isFinite(resetAt) ? resetAt * 1000 : null,
    resetAfterSeconds: Number.isFinite(resetAfter) ? resetAfter : null,
  };
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

/**
 * @param {Credentials} creds
 * @param {AbortSignal} [signal]
 */
export async function fetchQuota(creds, signal) {
  const data = await request('/wham/usage', creds, signal);
  const rateLimit = data?.rate_limit ?? {};
  const credits = data?.credits ?? {};
  const resetCredits = data?.rate_limit_reset_credits ?? {};

  return {
    planType: typeof data?.plan_type === 'string' ? data.plan_type : null,
    email: typeof data?.email === 'string' ? data.email : null,
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true,
    reachedType: typeof data?.rate_limit_reached_type === 'string' ? data.rate_limit_reached_type : null,
    primary: normalizeWindow(rateLimit.primary_window),
    secondary: normalizeWindow(rateLimit.secondary_window),
    codeReview: normalizeWindow(data?.code_review_rate_limit),
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
      overageLimitReached: credits.overage_limit_reached === true,
    },
    spendControl: {
      reached: data?.spend_control?.reached === true,
      individualLimit: data?.spend_control?.individual_limit ?? null,
    },
    resetCredits: {
      available: Number(resetCredits.available_count) || 0,
      applicable: Number(resetCredits.applicable_available_count) || 0,
    },
    modelUsage: normalizeModelUsage(data?.model_usage),
  };
}

function normalizeModelUsage(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([slug, value]) => ({
    slug,
    available: value?.available !== false,
    availableAt: Number.isFinite(Number(value?.available_at)) ? Number(value.available_at) * 1000 : null,
    creditsWouldEnable: value?.credits_would_enable === true,
  }));
}

/**
 * @param {Credentials} creds
 * @param {AbortSignal} [signal]
 */
export async function fetchModels(creds, signal) {
  const data = await request(`/codex/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`, creds, signal);
  const list = Array.isArray(data?.models) ? data.models : null;
  if (!list) throw new CodexError('bad_payload', '模型目录格式不认识');

  return list.map((model) => ({
    slug: String(model.slug ?? ''),
    displayName: String(model.display_name ?? model.slug ?? ''),
    description: typeof model.description === 'string' ? model.description : '',
    contextWindow: Number(model.context_window) || null,
    maxContextWindow: Number(model.max_context_window) || null,
    visibility: typeof model.visibility === 'string' ? model.visibility : null,
    priority: Number(model.priority) || null,
    minimalClientVersion: typeof model.minimal_client_version === 'string' ? model.minimal_client_version : null,
    defaultReasoningLevel: typeof model.default_reasoning_level === 'string' ? model.default_reasoning_level : null,
    reasoningLevels: Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((level) => (typeof level === 'object' && level ? String(level.effort ?? '') : String(level)))
          .filter(Boolean)
      : [],
    serviceTiers: Array.isArray(model.service_tiers)
      ? model.service_tiers
          .map((tier) => (typeof tier === 'object' && tier ? String(tier.name ?? tier.id ?? '') : String(tier)))
          .filter(Boolean)
      : [],
    supportsSearch: model.supports_search_tool === true,
    inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities.map(String) : [],
  }));
}
