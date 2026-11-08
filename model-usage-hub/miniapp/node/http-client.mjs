// @ts-check
/**
 * Outbound HTTP that follows this machine's actual network setup.
 *
 * Node's global fetch ignores both the Windows proxy registry entry and the
 * HTTP(S)_PROXY environment variables, so a board that only calls fetch() fails
 * on any machine that needs a proxy for chatgpt.com. Resolution order:
 *   1. explicit HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (respecting NO_PROXY)
 *   2. the Windows per-user proxy (Internet Settings) when ProxyEnable is set
 *   3. direct
 * Each request tries direct first only when nothing was configured; otherwise the
 * configured proxy is used and a direct retry happens once on connection failure.
 */

import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const registryChildren = new Set();
function trackedExec(...args) {
  const operation = execFileAsync(...args);
  registryChildren.add(operation.child);
  return operation.finally(() => registryChildren.delete(operation.child));
}
export function disposeNetwork() {
  for (const child of registryChildren) child?.kill();
  registryChildren.clear();
}
const TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** @type {{ proxy: string | null, resolved: boolean } | null} */
let proxyCache = null;

function normalizeProxy(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function envProxy() {
  return (
    normalizeProxy(process.env.HTTPS_PROXY) ||
    normalizeProxy(process.env.https_proxy) ||
    normalizeProxy(process.env.HTTP_PROXY) ||
    normalizeProxy(process.env.http_proxy) ||
    normalizeProxy(process.env.ALL_PROXY) ||
    normalizeProxy(process.env.all_proxy)
  );
}

/** @returns {Promise<string | null>} */
async function windowsProxy() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await trackedExec(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyEnable',
      ],
      { timeout: 4000, windowsHide: true }
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return null;
    const server = await trackedExec(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyServer',
      ],
      { timeout: 4000, windowsHide: true }
    );
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(server.stdout);
    if (!match) return null;
    const raw = match[1];
    // ProxyServer may be "host:port" or "http=host:port;https=host:port"
    if (raw.includes('=')) {
      const parts = Object.fromEntries(
        raw.split(';').map((chunk) => {
          const [scheme, target] = chunk.split('=');
          return [scheme?.trim().toLowerCase(), target?.trim()];
        })
      );
      return normalizeProxy(parts.https || parts.http || null);
    }
    return normalizeProxy(raw);
  } catch {
    return null;
  }
}

/** @returns {Promise<string | null>} */
export async function resolveProxy() {
  if (proxyCache && proxyCache.resolved) return proxyCache.proxy;
  const env = envProxy();
  const proxy = env || (await windowsProxy());
  proxyCache = { proxy, resolved: true };
  return proxy;
}

function bypassed(hostname) {
  // Never route this machine's configured local proxy services through an outbound proxy.
  if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname.toLowerCase())) return true;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (!noProxy) return false;
  return noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const bare = entry.replace(/^\./, '');
      return hostname.toLowerCase() === bare || hostname.toLowerCase().endsWith(`.${bare}`);
    });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {{ proxy: string | null, signal?: AbortSignal, method?: string, body?: string }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function once(url, headers, options) {
  const target = new URL(url);
  const { proxy, signal } = options;
  const method = options.method ?? 'GET';
  const body = options.body ?? null;
  const isHttps = target.protocol === 'https:';
  const bodyBuffer = body === null ? null : Buffer.from(body, 'utf8');
  const sendHeaders = bodyBuffer
    ? { ...headers, 'content-length': String(bodyBuffer.length) }
    : headers;

  return new Promise((resolve, reject) => {
    /** @type {(res: import('node:http').IncomingMessage) => void} */
    const onResponse = (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.destroy();
          reject(Object.assign(new Error('响应体过大'), { code: 'BODY_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    };

    if (!proxy) {
      const requester = isHttps ? httpsRequest : httpRequest;
      const req = requester(
        {
          method,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          headers: sendHeaders,
          signal,
        },
        onResponse
      );
      req.on('error', reject);
      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
      return;
    }

    const proxyUrl = new URL(proxy);
    const proxyAuth =
      proxyUrl.username || proxyUrl.password
        ? {
            'Proxy-Authorization': `Basic ${Buffer.from(
              `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
            ).toString('base64')}`,
          }
        : {};

    if (isHttps) {
      // CONNECT tunnel, then TLS inside it.
      const connectReq = httpRequest({
        method: 'CONNECT',
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        path: `${target.hostname}:${target.port || 443}`,
        headers: { host: `${target.hostname}:${target.port || 443}`, ...proxyAuth },
        signal,
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(Object.assign(new Error(`代理拒绝连接（${res.statusCode}）`), { code: 'PROXY_REJECTED' }));
          return;
        }
        const tlsSocket = tlsConnect(
          { socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] },
          () => {
            const req = httpsRequest(
              {
                method,
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                headers: sendHeaders,
                createConnection: () => tlsSocket,
                signal,
              },
              onResponse
            );
            req.on('error', reject);
            if (bodyBuffer) req.write(bodyBuffer);
            req.end();
          }
        );
        tlsSocket.on('error', reject);
      });
      connectReq.on('error', reject);
      connectReq.end();
      return;
    }

    // Plain HTTP through the proxy: absolute-form request line.
    const req = httpRequest(
      {
        method,
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        path: target.href,
        headers: { ...sendHeaders, host: target.host, ...proxyAuth },
        signal,
      },
      onResponse
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {AbortSignal} [signal]
 */
export async function getJson(url, headers, signal) {
  return send('GET', url, headers, null, signal);
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string} body
 * @param {AbortSignal} [signal]
 */
export async function postJson(url, headers, body, signal) {
  return send('POST', url, headers, body, signal);
}

/**
 * @param {string} method
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {string | null} body
 * @param {AbortSignal} [signal]
 */
async function send(method, url, headers, body, signal) {
  const proxy = await resolveProxy();
  const useProxy = proxy && !bypassed(new URL(url).hostname);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  /** @type {Array<string | null>} */
  const attempts = useProxy ? [proxy, null] : [null];
  /** @type {any} */
  let lastError = null;

  for (const candidate of attempts) {
    try {
      const result = await once(url, headers, {
        proxy: candidate,
        signal: combined,
        method,
        body: body ?? undefined,
      });
      return { ...result, viaProxy: candidate !== null };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (error?.code === 'PROXY_REJECTED' || error?.code === 'BODY_TOO_LARGE') throw error;
    }
  }
  throw lastError ?? Object.assign(new Error('请求失败'), { code: 'UNKNOWN' });
}

/** Exposed for tests and diagnostics. */
export const _internal = { netConnect, normalizeProxy };
