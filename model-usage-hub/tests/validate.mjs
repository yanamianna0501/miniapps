import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readConfig, readCodex } from '../miniapp/node/source.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(join(root, '.minimax-plugin/plugin.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'miniapp/miniapp.json'), 'utf8'));
assert.deepEqual(pkg.mcode, { schemaVersion: 2, miniApp: './miniapp/miniapp.json' });
assert.equal(plugin.name, 'model-usage-hub');
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
assert.ok(plugin.exampleQueries.length > 0);
assert.equal(plugin.icon, 'icon.png');
assert.deepEqual(manifest, { schemaVersion: 1, artifacts: { client: ['./miniapp/client'], node: ['./miniapp/node'] }, runtime: { kind: 'process', entry: './miniapp/node/server.mjs', lifecycle: 'on-demand' }, surface: { path: '/dashboard' }, mcpEndpoints: [] });
const icon = await readFile(join(root, plugin.icon));
assert.ok(icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    assert.ok(!(await lstat(path)).isSymbolicLink(), 'runtime payload must not contain symlinks');
    if (entry.isDirectory()) { assert.notEqual(entry.name, 'node_modules'); await walk(path); }
    else files.push(path);
  }
}
await walk(join(root, 'miniapp'));
let totalBytes = icon.length;
let checkedJs = 0;
const textFiles = [];
for (const path of files) {
  const body = await readFile(path);
  totalBytes += body.length;
  if (/\.(mjs|js)$/.test(path)) {
    execFileSync(process.execPath, ['--check', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    checkedJs++;
  }
  if (/\.(mjs|js|py|html|css|ts|json)$/.test(path)) textFiles.push(body.toString('utf8'));
}
textFiles.push(JSON.stringify(plugin), JSON.stringify(pkg), JSON.stringify(manifest));
const html = await readFile(join(root, 'miniapp/client/index.html'), 'utf8');
const js = await readFile(join(root, 'miniapp/client/app.js'), 'utf8');
for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), `missing DOM id: ${match[1]}`);
assert.ok(!js.includes('/api/session'), 'session detail route must not be used');
assert.ok(!/https?:\/\//.test(html), 'Client must use local assets');
const children = new Set();
let secretCount = 0;
if (process.argv[2]) {
  const providers = await readConfig(process.argv[2], AbortSignal.timeout(15000), children);
  const auth = await readCodex(process.argv[2]);
  const secrets = [...providers.map(p => p.apiKey), auth.accessToken, auth.accountId].filter(s => typeof s === 'string' && s.length >= 8);
  for (const secret of secrets) {
    for (const body of textFiles) assert.ok(!body.includes(secret), 'a configured credential was found in the payload');
    secretCount++;
  }
}
console.log(JSON.stringify({ result: 'PASS', payloadFiles: files.length, checkedJs, payloadBytes: totalBytes, credentialLeakChecks: secretCount, declarations: 'valid', sessionDetailClient: 'absent', files: files.map(p => relative(root, p).split(sep).join('/')) }));
