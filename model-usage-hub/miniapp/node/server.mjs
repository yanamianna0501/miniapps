// @ts-check
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { resolveRoot, DataError } from './source.mjs';
import { createService, ranges } from './service.mjs';
import { disposeNetwork } from './http-client.mjs';

/** @typedef {import('./miniapp-api.js').MiniAppContext} MiniAppContext */
/** @param {MiniAppContext} context */
export async function start(context) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, context.signal]);
  const children = new Set();
  let service;
  const getService = () => service ??= createService(resolveRoot(context), signal, children);
  const assets = new Map([
    ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ]);
  const send = (res, status, payload, extra = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(JSON.stringify(payload));
  };
  const server = createServer((req, res) => {
    const handle = async () => {
      const url = new URL(req.url || '/', 'http://miniapp.local');
      if (req.method === 'POST') {
        if (url.pathname === '/api/proxy/control') {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
            if (chunks.reduce((s, c) => s + c.length, 0) > 16384) throw new Error('请求体过大');
          }
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return send(res, 400, { error: { code: 'invalid_json', message: '请求体必须是 JSON' } }); }
          const { id, action } = parsed || {};
          if (!id || !['start', 'stop'].includes(action)) {
            return send(res, 400, { error: { code: 'invalid_params', message: '参数无效，必须指定 id 与 action(start|stop)' } });
          }
          const active = getService();
          const result = await active.controlProxy(id, action);
          context.logger.info('modelhub.proxy.control', { id, action, ok: result.ok });
          return send(res, 200, result);
        }
        return send(res, 405, { error: { code: 'method_not_allowed', message: '接口不支持该方法' } });
      }
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'method_not_allowed', message: '此应用仅支持 GET 与指定控制 POST' } });
      const asset = assets.get(url.pathname === '/' ? '/dashboard' : url.pathname);
      if (asset) {
        const body = await readFile(join(context.pluginRoot, 'miniapp/client', asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" });
        res.end(body);
        return;
      }
      if (!['/api/overview', '/api/providers', '/api/export'].includes(url.pathname)) return send(res, 404, { error: { code: 'not_found', message: '页面或接口不存在' } });
      const range = url.searchParams.get('range') || '7d';
      if (!ranges.has(range)) return send(res, 400, { error: { code: 'invalid_range', message: '请选择 7 天、30 天或全部时间' } });
      if (url.searchParams.has('refresh') && !['0', '1'].includes(url.searchParams.get('refresh'))) return send(res, 400, { error: { code: 'invalid_refresh', message: '刷新参数无效' } });
      const active = getService();
      if (url.pathname === '/api/overview') {
        const data = await active.overview(range);
        context.logger.info('modelhub.overview.read', { calls: data.kpi.calls, models: data.models.length });
        return send(res, 200, data);
      }
      if (url.pathname === '/api/providers') {
        const data = await active.providers(range, url.searchParams.get('refresh') === '1');
        context.logger.info('modelhub.providers.read', { providers: data.providers.length, success: data.providers.filter(p => p.quota.status === 'ok').length });
        return send(res, 200, data);
      }
      const [overview, registry] = await Promise.all([active.overview(range), active.providers(range)]);
      const data = { meta: { source: '本机 MCode 只读用量与服务商额度查询', date: new Date().toISOString(),
        version: '1.0.0', range, count: registry.providers.reduce((sum, p) => sum + p.models.length, 0),
        fields: { overview: '本机调用与上下文聚合', providers: '配置模型及服务商共享额度', unassignedCalls: '未能归属到当前配置模型的调用数' },
        notes: ['不含会话明细、账号身份、凭据或本机路径', '输入+输出不是账单金额；不涵盖其他设备', '额度按服务商/账户共享，不按模型重复累加', '未知或失败数据不是零余额'] },
        items: { overview, providers: registry.providers, unassignedCalls: registry.unassignedCalls } };
      return send(res, 200, data, { 'Content-Disposition': `attachment; filename="model-usage-${range}-${new Date().toISOString().slice(0, 10)}.json"` });
    };
    void handle().catch(error => {
      const safe = error instanceof DataError ? { code: error.code, message: error.message } : { code: 'data_read_failed', message: '数据读取失败，请检查本机用量库、配置读取权限或稍后重试' };
      context.logger.warn('modelhub.read.failed', { code: safe.code });
      send(res, 503, { error: safe });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.listen.port, context.listen.host, () => { server.removeListener('error', reject); resolve(); });
  });
  context.logger.info('miniapp.runtime.listening');
  let disposal;
  const dispose = () => disposal ??= (async () => {
    controller.abort();
    context.signal.removeEventListener('abort', onAbort);
    for (const child of children) child.kill();
    children.clear();
    disposeNetwork();
    service?.clear();
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  })();
  const onAbort = () => { void dispose(); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();
  return { dispose };
}
