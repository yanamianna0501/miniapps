// @ts-check
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

import { exchangeRefreshToken, listCredentials, persistRenewal } from './auth.mjs';
import { CodexError, fetchModels, fetchQuota } from './codex-api.mjs';
import { openStore } from './store.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @typedef {import('./auth.mjs').Credentials} Credentials */

const SAMPLE_INTERVAL_MS = 10 * 60 * 1000;
const MIN_SAMPLE_GAP_MS = 20 * 1000;
/** Renew ahead of expiry so a page open never lands on a dead token. */
const RENEW_BEFORE_MS = 2 * 86400000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * @param {MiniAppContext} context
 */
export async function start(context) {
  const clientRoot = join(context.pluginRoot, 'miniapp', 'client');
  const store = await openStore(context.dataDir);

  /** Last successful snapshot, kept so the page can render instantly. */
  let lastQuota = null;
  let lastModels = null;
  let lastError = null;
  let lastFetchAt = 0;
  let inflight = null;

  /**
   * Directories that may hold this app's own codex-auth.json. pluginRoot sits at
   * <dataDir>/plugins/<pluginId>/miniapp, so walk up to the data root.
   */
  const extraAuthRoots = [];
  {
    let dir = context.pluginRoot;
    for (let i = 0; i < 4 && dir; i += 1) {
      extraAuthRoots.push(dir);
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }

  /**
   * Make sure a credential is usable, renewing it in place when it is close to
   * expiry or has no known expiry. A renewal that fails is not fatal: the caller
   * still tries the token it has.
   * @param {Credentials} creds
   * @param {AbortSignal} signal
   * @returns {Promise<{ creds: Credentials, renewed: boolean }>}
   */
  async function ensureFresh(creds, signal) {
    if (!creds.refreshToken) return { creds, renewed: false };
    const expiresAt = creds.expiresAt;
    const needsRenewal = expiresAt !== null && expiresAt - Date.now() < RENEW_BEFORE_MS;
    if (!needsRenewal) return { creds, renewed: false };

    try {
      const tokens = await exchangeRefreshToken(creds.refreshToken, signal);
      const saved = await persistRenewal(creds, tokens);
      context.logger.info('miniapp.auth.renewed', { saved, source: creds.kind });
      return {
        creds: {
          ...creds,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
        renewed: true,
      };
    } catch (error) {
      const code = /** @type {any} */ (error)?.code ?? 'refresh_failed';
      context.logger.warn('miniapp.auth.renew_failed', { code, source: creds.kind });
      return { creds, renewed: false };
    }
  }

  /**
   * One read attempt with a specific credential; on success it becomes the cached
   * snapshot the page renders.
   * @param {Credentials} creds
   * @param {boolean} renewed
   * @param {AbortSignal} signal
   */
  async function readWith(creds, renewed, signal) {
    const [quota, models] = await Promise.all([
      fetchQuota(creds, signal),
      fetchModels(creds, signal),
    ]);
    lastQuota = quota;
    lastModels = models;
    lastFetchAt = Date.now();
    return {
      quota,
      models,
      fetchedAt: lastFetchAt,
      cached: false,
      credentials: {
        source: creds.source,
        expiresAt: creds.expiresAt,
        autoRenewed: renewed,
        renewable: Boolean(creds.refreshToken),
      },
    };
  }

  /**
   * Fetch both endpoints once and record a history sample.
   * @param {AbortSignal} signal
   * @param {{ force?: boolean }} [options]
   */
  async function refresh(signal, options = {}) {
    const now = Date.now();
    if (!options.force && lastQuota && now - lastFetchAt < 15000) {
      return { quota: lastQuota, models: lastModels, fetchedAt: lastFetchAt, cached: true };
    }
    if (inflight) return inflight;

    inflight = (async () => {
      const candidates = await listCredentials(extraAuthRoots);
      if (candidates.length === 0) {
        throw new CodexError('no_credentials', '没找到 ChatGPT 登录信息，请先在 Codex CLI 或 MiniMax Code 里登录');
      }

      // Try each sign-in in freshness order; only a stale credential moves on.
      /** @type {unknown} */
      let lastError = null;
      for (const candidate of candidates) {
        const { creds, renewed } = await ensureFresh(candidate, signal);
        try {
          return await readWith(creds, renewed, signal);
        } catch (error) {
          lastError = error;
          if (!(error instanceof CodexError) || error.code !== 'unauthorized') throw error;

          // The token was rejected. If it had a refresh token and we have not just
          // renewed it, renew once and retry before moving to the next sign-in.
          if (creds.refreshToken && !renewed) {
            try {
              const tokens = await exchangeRefreshToken(creds.refreshToken, signal);
              await persistRenewal(creds, tokens);
              context.logger.info('miniapp.auth.renewed_on_401', { source: creds.kind });
              const retried = {
                ...creds,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
              };
              return await readWith(retried, true, signal);
            } catch (renewError) {
              lastError = renewError;
            }
          }
        }
      }
      throw lastError ?? new CodexError('unauthorized', '所有本机登录都已失效，请重新登录');
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /** Record a history point, skipping rapid repeats. */
  function record(quota) {
    if (!quota) return store.snapshot();
    const last = store.snapshot().lastSampleAt;
    if (last && Date.now() - last < MIN_SAMPLE_GAP_MS) return store.snapshot();
    return store.record({ primary: quota.primary, secondary: quota.secondary });
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {unknown} body
   */
  function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(payload);
  }

  async function serveStatic(response, pathname) {
    const relative = normalize(pathname.replace(/^\/+/, ''));
    if (relative.startsWith('..') || relative.split(sep).includes('..')) {
      response.writeHead(403).end();
      return;
    }
    const file = join(clientRoot, relative);
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not_found' }));
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://miniapp.local');
    const { pathname } = url;

    if (pathname.startsWith('/__mavis/')) {
      response.writeHead(404).end();
      return;
    }

    if (pathname === '/api/snapshot' && request.method === 'GET') {
      try {
        const result = await refresh(context.signal, { force: url.searchParams.get('refresh') === '1' });
        const history = record(result.quota);
        sendJson(response, 200, {
          ok: true,
          ...result,
          history,
        });
      } catch (error) {
        const known = error instanceof CodexError;
        const code = known ? error.code : 'unexpected';
        const message = known ? error.message : '读取 ChatGPT 数据时出错';
        lastError = { code, message };
        context.logger.warn('miniapp.quota.fetch_failed', { code });
        sendJson(response, 200, {
          ok: false,
          error: lastError,
          quota: lastQuota,
          models: lastModels,
          fetchedAt: lastFetchAt || null,
          history: store.snapshot(),
        });
      }
      return;
    }

    if (pathname === '/dashboard' || pathname === '/' || pathname === '/index.html') {
      await serveStatic(response, 'index.html');
      return;
    }

    if (request.method === 'GET' && MIME[extname(pathname)]) {
      await serveStatic(response, pathname);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  // Keep sampling while the board runs, so the trend fills in even when the tab is closed.
  const timer = setInterval(() => {
    void refresh(context.signal)
      .then((result) => record(result.quota))
      .catch(() => undefined);
  }, SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  context.logger.info('miniapp.runtime.listening');

  let disposal = null;
  const dispose = () => {
    if (disposal) return disposal;
    clearInterval(timer);
    context.signal.removeEventListener('abort', onAbort);
    disposal = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
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
