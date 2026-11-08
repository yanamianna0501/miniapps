// @ts-check
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { postJson } from './http-client.mjs';

/**
 * Locate usable ChatGPT/Codex sign-ins on this machine and, when one goes stale,
 * renew it in place so the user does not have to sign in again.
 *
 * Supported layouts:
 *  - Codex CLI   ~/.codex/auth.json   { tokens: { access_token, refresh_token, account_id } }
 *  - MiniMax Code codex-auth.json     { "openai-codex": { access, refresh, expires, accountId } }
 *
 * Both carry a refresh token whose exchange returns a *rotated* refresh token, so a
 * successful refresh must be persisted or the next renewal eventually fails. Writes
 * are atomic and keep every other field of the file untouched.
 */

/**
 * @typedef {{
 *   accessToken: string,
 *   accountId: string,
 *   refreshToken: string | null,
 *   source: string,
 *   kind: 'codex-cli' | 'mcode' | 'env',
 *   filePath: string,
 *   expiresAt: number | null,
 * }} Credentials
 */

const SOURCE_LABEL = {
  'codex-cli': 'Codex CLI 登录',
  mcode: 'MiniMax Code 登录',
  env: '自定义登录文件',
};

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * @param {string[]} [extraRoots] additional directories that may hold a codex-auth.json
 */
function candidatePaths(extraRoots = []) {
  /** @type {Array<{ path: string, kind: keyof typeof SOURCE_LABEL }>} */
  const list = [];
  const envPath = process.env.CODEX_AUTH_FILE;
  if (envPath) list.push({ path: envPath, kind: 'env' });
  const home = homedir();
  list.push({ path: join(home, '.codex', 'auth.json'), kind: 'codex-cli' });
  for (const root of extraRoots) {
    if (typeof root === 'string' && root) list.push({ path: join(root, 'codex-auth.json'), kind: 'mcode' });
  }
  list.push({ path: join(home, '.minimax', 'codex-auth.json'), kind: 'mcode' });
  list.push({ path: join(home, 'AppData', 'Local', 'minimax', 'codex-auth.json'), kind: 'mcode' });
  list.push({ path: join(home, 'AppData', 'Roaming', 'minimax', 'codex-auth.json'), kind: 'mcode' });
  if (process.env.MCODE_DATA_DIR) {
    list.push({ path: join(process.env.MCODE_DATA_DIR, 'codex-auth.json'), kind: 'mcode' });
  }
  return list;
}

/**
 * Read `exp` out of a JWT without verifying it — we only use it as a UI hint.
 * @param {string} token
 * @returns {number | null} milliseconds, or null when unreadable
 */
function jwtExpiry(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {keyof typeof SOURCE_LABEL} kind
 * @returns {Promise<Credentials | null>}
 */
async function parseFile(path, kind) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  const cli = json.tokens;
  if (cli && typeof cli.access_token === 'string' && typeof cli.account_id === 'string') {
    return {
      accessToken: cli.access_token,
      accountId: cli.account_id,
      refreshToken: typeof cli.refresh_token === 'string' ? cli.refresh_token : null,
      source: SOURCE_LABEL[kind],
      kind,
      filePath: path,
      expiresAt: jwtExpiry(cli.access_token),
    };
  }

  const mcode = json['openai-codex'];
  if (mcode && typeof mcode.access === 'string' && typeof mcode.accountId === 'string') {
    const declared = Number(mcode.expires);
    const fromJwt = jwtExpiry(mcode.access);
    const expiresAt =
      Number.isFinite(declared) && declared > 0 ? Math.round(declared) : fromJwt;
    return {
      accessToken: mcode.access,
      accountId: mcode.accountId,
      refreshToken: typeof mcode.refresh === 'string' ? mcode.refresh : null,
      source: SOURCE_LABEL[kind],
      kind,
      filePath: path,
      expiresAt,
    };
  }
  return null;
}

/**
 * Every structurally valid candidate, freshest first: unexpired by later expiry,
 * then unknown expiry, then already-expired.
 * @param {string[]} [extraRoots]
 * @returns {Promise<Credentials[]>}
 */
export async function listCredentials(extraRoots = []) {
  const found = [];
  const seen = new Set();
  for (const candidate of candidatePaths(extraRoots)) {
    const creds = await parseFile(candidate.path, candidate.kind);
    if (!creds) continue;
    const key = `${creds.accountId}|${creds.accessToken.slice(-24)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(creds);
  }

  const now = Date.now();
  const rank = (creds) => {
    if (creds.expiresAt === null) return 1;
    return creds.expiresAt > now ? 0 : 2;
  };

  return found.sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    if (a.expiresAt && b.expiresAt) return b.expiresAt - a.expiresAt;
    return 0;
  });
}

/**
 * Exchange a refresh token for a new access token. The response contains a rotated
 * refresh token that must be stored.
 * @param {string} refreshToken
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number | null, idToken: string | null }>}
 */
export async function exchangeRefreshToken(refreshToken, signal) {
  const payload = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  let response;
  try {
    response = await postJson(
      TOKEN_URL,
      { 'content-type': 'application/json', accept: 'application/json' },
      payload,
      signal ?? AbortSignal.timeout(20000)
    );
  } catch (error) {
    const failure = new Error('连不上续期服务，请检查网络或代理');
    failure.name = 'RefreshError';
    // @ts-expect-error extra field for the caller
    failure.code = 'refresh_unreachable';
    throw failure;
  }

  const { status, body } = response;
  if (status < 200 || status >= 300) {
    const error = new Error(
      status === 401 || status === 400
        ? 'refresh_token 已失效，需要重新登录一次'
        : `续期请求失败（${status}）`
    );
    error.name = 'RefreshError';
    // @ts-expect-error extra field for the caller
    error.code = status === 401 || status === 400 ? 'refresh_expired' : 'refresh_failed';
    throw error;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    const error = new Error('续期返回了无法解析的内容');
    error.name = 'RefreshError';
    // @ts-expect-error extra field
    error.code = 'refresh_failed';
    throw error;
  }

  const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
  const rotated = typeof json.refresh_token === 'string' ? json.refresh_token : null;
  if (!accessToken || !rotated) {
    const error = new Error('续期返回缺少 token');
    error.name = 'RefreshError';
    // @ts-expect-error extra field
    error.code = 'refresh_failed';
    throw error;
  }

  return {
    accessToken,
    refreshToken: rotated,
    expiresAt: jwtExpiry(accessToken),
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
  };
}

/**
 * Persist renewed tokens back into the file they came from, keeping every other
 * field as-is. Writes through a temporary file plus rename, and leaves a one-shot
 * backup next to the original the first time it changes anything.
 *
 * @param {Credentials} creds
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number | null, idToken: string | null }} tokens
 * @returns {Promise<boolean>} whether the file was updated
 */
export async function persistRenewal(creds, tokens) {
  let raw;
  try {
    raw = await readFile(creds.filePath, 'utf8');
  } catch {
    return false;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!json || typeof json !== 'object') return false;

  if (json.tokens && typeof json.tokens === 'object') {
    json.tokens.access_token = tokens.accessToken;
    json.tokens.refresh_token = tokens.refreshToken;
    if (tokens.idToken) json.tokens.id_token = tokens.idToken;
    json.last_refresh = new Date().toISOString();
  } else if (json['openai-codex'] && typeof json['openai-codex'] === 'object') {
    const node = json['openai-codex'];
    node.access = tokens.accessToken;
    node.refresh = tokens.refreshToken;
    node.expires = tokens.expiresAt ?? Date.now() + 10 * 86400000;
  } else {
    return false;
  }

  const temp = `${creds.filePath}.mcode-tmp`;
  try {
    await writeFile(temp, JSON.stringify(json, null, 2), 'utf8');
    // Keep one recoverable copy before the first rewrite.
    try {
      await copyFile(creds.filePath, `${creds.filePath}.bak-before-renewal`);
    } catch {
      // A missing backup must not block the renewal itself.
    }
    await rename(temp, creds.filePath);
    return true;
  } catch {
    try {
      await writeFile(temp, '', 'utf8');
    } catch {
      // ignore
    }
    return false;
  }
}

/** Exposed so callers can explain where the credentials came from. */
export function describeSource(creds) {
  return { source: creds.source, expiresAt: creds.expiresAt, file: dirname(creds.filePath) };
}
