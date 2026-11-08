import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_READER = fileURLToPath(new URL('./config-reader.py', import.meta.url));
export class DataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function resolveRoot(context) {
  for (const start of [context.dataDir, context.pluginRoot, process.env.MCODE_DATA_DIR]) {
    if (!start) continue;
    let current = start;
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(current, 'config.yaml')) && existsSync(join(current, 'v2/sqlite/runtime-state.sqlite'))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new DataError('data_root_missing', '未找到当前 MCode 数据目录');
}
export function openUsage(root) {
  const db = new DatabaseSync(join(root, 'v2/sqlite/runtime-state.sqlite'), { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN;');
  return { jsonSupport: true, query: (sql, params = []) => db.prepare(sql).all(...params), close: () => db.close() };
}
export async function readConfig(root, signal, children) {
  const candidates = [process.env.MODEL_HUB_PYTHON, join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Programs/Python/Python312/python.exe'), 'python'].filter(Boolean);
  for (const exe of candidates) {
    // A denied filesystem read is not a reason to try another executable.
    if (exe.includes('/') || exe.includes('\\')) { if (!existsSync(exe)) continue; }
    try {
      const raw = await new Promise((resolve, reject) => {
        const child = execFile(exe, [CONFIG_READER, root], {
          encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 12000,
          windowsHide: true, signal,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        }, (error, stdout) => {
          children?.delete(child);
          if (error) reject(new DataError(error.code === 'ENOENT' ? 'python_missing' : 'config_read_failed', '无法读取模型配置，请检查 Python / 随包 YAML 解析器 或文件权限'));
          else resolve(stdout);
        });
        children?.add(child);
      });
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.providers) || !parsed.providers.length) throw new DataError('config_shape', '模型配置结构无效');
      return parsed.providers;
    } catch (e) {
      if (e.code === 'python_missing') continue;
      throw new DataError(e.code || 'config_read_failed', '模型配置读取失败，请检查 Python / 随包 YAML 解析器 和文件权限');
    }
  }
  throw new DataError('python_missing', '缺少已安装的 Python 3.12 / PyYAML');
}
export async function readCodex(root) {
  let raw;
  try { raw = JSON.parse(await readFile(join(root, 'codex-auth.json'), 'utf8')); }
  catch { throw new DataError('codex_auth_missing', '请在 MCode 重新登录 Codex'); }
  const auth = raw['openai-codex'];
  if (!auth || typeof auth.access !== 'string' || typeof auth.accountId !== 'string') throw new DataError('codex_auth_missing', 'Codex 登录数据不完整，请重新登录');
  // Read-only by design: never rotate or persist the shared refresh token.
  return { accessToken: auth.access, accountId: auth.accountId };
}
export async function readGoogleAntigravity(root) {
  const candidates = [
    'F:/Zcode项目/杂项/google-pro-gateway/private/auth',
    'F:\\Zcode项目\\杂项\\google-pro-gateway\\private\\auth',
    join(root, 'google-pro-gateway/private/auth'),
    join(root, 'private/auth'),
    join(dirname(root), 'google-pro-gateway/private/auth'),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.startsWith('antigravity-') || !file.endsWith('.json')) continue;
        const filePath = join(dir, file);
        const raw = JSON.parse(await readFile(filePath, 'utf8'));
        if (typeof raw?.access_token === 'string' && raw.access_token.length >= 20) {
          const endpoint = typeof raw.antigravity_capability_hints?.endpoint === 'string'
            ? raw.antigravity_capability_hints.endpoint
            : 'https://daily-cloudcode-pa.googleapis.com';
          const projectId = typeof raw.project_id === 'string' ? raw.project_id : 'aicode-consumers';
          return {
            accessToken: raw.access_token,
            endpoint,
            projectId,
            email: typeof raw.email === 'string' ? raw.email : null,
          };
        }
      }
    } catch {
      // ignore read error and try next candidate
    }
  }
  throw new DataError('antigravity_auth_missing', '未找到有效的 Antigravity 登录凭据，请检查 google-pro-gateway 凭据文件');
}
