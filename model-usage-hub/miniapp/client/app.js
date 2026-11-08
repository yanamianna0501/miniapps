'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 50;
  const state = {
    range: '7d', overview: null, providers: null,
    overviewSeq: 0, providerSeq: 0,
    pages: { models: 0, configured: 0 },
  };
  const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const list = (value) => Array.isArray(value) ? value : [];
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const fmt = (value) => number(value) === null ? '—' : integer.format(value);
  const pct = (value) => number(value) === null ? '—' : `${decimal.format(value * 100)}%`;
  const text = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
  const matches = (query, ...values) => values.some((value) => text(value, '').toLocaleLowerCase().includes(query));
  const sumTokens = (row) => number(row.billedTokens) ?? ((number(row.inputTokens) ?? 0) + (number(row.outputTokens) ?? 0));
  const byUsage = (a, b) => sumTokens(b) - sumTokens(a);

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = text(content, '');
    return node;
  }
  function replace(id, ...children) { $(id).replaceChildren(...children); }
  function empty(content) { return el('p', 'empty', content); }
  function button(label, handler, className) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }
  function dateTime(value) {
    const ts = number(value);
    if (ts === null || ts <= 0) return '—';
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
  }
  function setStatus(id, message, isError = false) {
    const node = $(id);
    node.textContent = message;
    node.classList.toggle('error', isError);
  }
  async function request(url, options = {}) {
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', relay, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 30000);
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...(options.headers || {}) },
        body: options.body,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(response.ok ? '服务返回的数据格式异常，请重试。' : `请求失败（${response.status}），请重试。`); }
      if (!response.ok) throw new Error(typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : `请求失败（${response.status}），请重试。`);
      if (!data || typeof data !== 'object') throw new Error('服务返回的数据不完整，请重试。');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时或已取消，请重试。');
      if (error instanceof TypeError) throw new Error('无法连接本地服务，请确认应用仍在运行后重试。');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
    }
  }
  function makeTable(headers, rows, caption) {
    const table = el('table');
    if (caption) table.append(el('caption', '', caption));
    const head = el('thead');
    const headRow = el('tr');
    headers.forEach((label) => { const th = el('th', '', label); th.scope = 'col'; headRow.append(th); });
    head.append(headRow);
    const body = el('tbody');
    rows.forEach((cells) => {
      const tr = el('tr');
      cells.forEach((value, index) => {
        const td = el('td', index === 0 ? 'cell-name' : '');
        if (value instanceof Node) td.append(value);
        else td.textContent = text(value);
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body);
    return table;
  }
  function pageRows(key, rows, render) {
    const last = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
    state.pages[key] = Math.min(state.pages[key], last);
    const page = state.pages[key];
    const pager = $(`${key}-pager`);
    pager.replaceChildren();
    if (rows.length) pager.append(el('span', '', `共 ${fmt(rows.length)} 条 · 第 ${page + 1} / ${last + 1} 页`));
    if (last > 0) {
      const prev = button('上一页', () => { state.pages[key]--; render(); });
      const next = button('下一页', () => { state.pages[key]++; render(); });
      prev.disabled = page === 0;
      next.disabled = page === last;
      pager.append(prev, next);
    }
    return rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }
  function meter(ratio) {
    const node = el('div', 'meter');
    node.setAttribute('aria-hidden', 'true');
    const fill = el('div', `meter-fill${ratio >= .9 ? ' danger' : ratio >= .75 ? ' warning' : ''}`);
    fill.style.width = `${Math.max(0, Math.min(100, (number(ratio) ?? 0) * 100))}%`;
    node.append(fill);
    return node;
  }
  function renderKpis() {
    const k = state.overview.kpi ?? {};
    $('kpi-calls').textContent = fmt(k.calls);
    $('kpi-tokens').textContent = fmt(k.billedTokens);
    $('kpi-cache').textContent = pct(k.cacheHitRate);
    $('kpi-sessions').textContent = fmt(k.sessions);
    $('kpi-cache-note').textContent = `缓存读取 ${fmt(k.cacheReadTokens)} Tokens`;
    $('kpi-turns').textContent = `共 ${fmt(k.turns)} 轮对话`;
  }
  function renderTrend() {
    const daily = [...list(state.overview.daily)].sort((a, b) => text(a.date).localeCompare(text(b.date)));
    if (!daily.length) { replace('trend', empty('所选范围暂无每日用量记录。')); return; }
    const bucketSize = Math.max(1, Math.ceil(daily.length / 60));
    const buckets = [];
    for (let i = 0; i < daily.length; i += bucketSize) {
      const slice = daily.slice(i, i + bucketSize);
      buckets.push({ start: slice[0].date, end: slice[slice.length - 1].date, tokens: slice.reduce((n, item) => n + sumTokens(item), 0), calls: slice.reduce((n, item) => n + (number(item.calls) ?? 0), 0) });
    }
    const max = Math.max(1, ...buckets.map((item) => item.tokens));
    const total = buckets.reduce((n, item) => n + item.tokens, 0);
    const summary = el('p', 'chart-summary', `${fmt(daily.length)} 个统计日期 · 合计 ${fmt(total)} Tokens${bucketSize > 1 ? ` · 每柱至多 ${bucketSize} 天合计` : ''}`);
    const bars = el('div', 'bars');
    bars.setAttribute('role', 'list');
    bars.setAttribute('aria-label', '每日输入加输出 Tokens 趋势；每柱可键盘聚焦查看数值');
    buckets.forEach((item) => {
      const col = el('div', 'bar-col');
      const label = `${text(item.start)}${item.end !== item.start ? ` 至 ${text(item.end)}` : ''}：${fmt(item.tokens)} Tokens，${fmt(item.calls)} 次请求`;
      col.setAttribute('role', 'listitem');
      col.setAttribute('aria-label', label);
      col.title = label;
      col.tabIndex = 0;
      const bar = el('div', 'bar');
      bar.style.height = `${item.tokens / max * 100}%`;
      col.append(bar);
      bars.append(col);
    });
    const axis = el('div', 'axis');
    axis.append(el('span', '', text(daily[0].date)), el('span', '', `柱高上限 ${fmt(max)} Tokens`), el('span', '', text(daily[daily.length - 1].date)));
    replace('trend', summary, bars, axis);
  }
  function renderPressure() {
    const models = list(state.overview.models).filter((m) => number(m.peakRatio) !== null).sort((a, b) => b.peakRatio - a.peakRatio).slice(0, 6);
    const content = el('div');
    if (!models.length) content.append(empty('暂无可用上下文采样，未按零占用计算。'));
    models.forEach((model) => {
      const row = el('div', 'pressure-row');
      row.append(el('span', 'pressure-name', text(model.shortName ?? model.model)), meter(model.peakRatio), el('span', 'ratio', pct(model.peakRatio)));
      content.append(row);
    });
    const context = state.overview.context;
    if (context?.available && context.global && list(context.global.components).length) {
      const composition = el('div', 'composition');
      composition.append(el('h3', '', '会话最新快照构成'));
      composition.append(el('p', 'meta', `各会话最近快照累加 · ${fmt(context.global.usedTokens)} Tokens · 非当前单一会话占用`));
      const parts = el('div', 'composition-list');
      context.global.components.forEach((part) => parts.append(el('span', 'meta', `${text(part.label ?? part.kind)} ${fmt(part.tokens)}（${pct(part.share)}）`)));
      composition.append(parts);
      content.append(composition);
    }
    replace('pressure', content);
  }
  function renderModels() {
    if (!state.overview) return;
    const query = $('model-search').value.trim().toLocaleLowerCase();
    const rows = list(state.overview.models).filter((m) => matches(query, m.model, m.shortName)).sort(byUsage);
    const visible = pageRows('models', rows, renderModels);
    if (!visible.length) { replace('models-table', empty(query ? '未找到匹配的历史模型。' : '所选范围暂无模型调用记录。')); return; }
    const cells = visible.map((m) => {
      const name = el('div', 'mono', text(m.model));
      const sample = number(m.peakRatio) === null ? '无采样' : `${pct(m.avgRatio)} / ${pct(m.peakRatio)}`;
      if (m.telemetryMissing) name.append(el('span', 'cell-sub', '部分上下文遥测缺失'));
      return [name, fmt(m.calls), fmt(m.inputTokens), fmt(m.outputTokens), fmt(m.cacheReadTokens), fmt(m.billedTokens), pct(m.cacheHitRate), fmt(m.windowTokens), sample];
    });
    replace('models-table', makeTable(['模型', '请求', '未缓存输入', '输出', '缓存读取', '输入 + 输出', '缓存命中', '上下文窗口', '占用均值 / 峰值'], cells));
  }
  const quotaStatuses = {
    ok: ['已获取', 'ok'], unsupported: ['暂不支持', 'warning'],
    auth_required: ['需要授权', 'warning'], error: ['查询失败', 'error'],
  };
  function resetTimestamp(value) {
    const ts = number(value);
    return ts === null || ts <= 0 ? null : (ts < 100000000000 ? ts * 1000 : ts);
  }
  function countdown(ts) {
    const delta = ts - Date.now();
    if (delta <= 0) return '重置时间已到，刷新额度核对';
    const minutes = Math.ceil(delta / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return `${days ? `${days}天 ` : ''}${hours ? `${hours}小时 ` : ''}${minutes % 60}分钟后重置`;
  }
  function renderProviders() {
    const providers = list(state.providers?.providers);
    if (!providers.length) { replace('providers', empty('未发现已配置服务商。')); return; }
    const cards = providers.map((provider) => {
      const card = el('article', 'provider-card');
      const quota = provider.quota ?? {};
      const [statusLabel, statusClass] = quotaStatuses[quota.status] ?? ['状态未知', 'warning'];
      const head = el('div', 'provider-title');
      head.append(el('h3', '', text(provider.name ?? provider.id)), el('span', `badge ${statusClass}`, statusLabel));
      card.append(head);
      if (provider.proxy?.supported) {
        const proxyBox = el('div', 'proxy-box');
        const proxyInfo = el('div', 'proxy-info');
        const isRunning = Boolean(provider.proxy.running);
        const dot = el('span', `proxy-dot ${isRunning ? 'running' : 'stopped'}`);
        const statusMsg = el('span', 'proxy-text', isRunning
          ? `本机反代运行中 · 端口 ${provider.proxy.port}`
          : `本机反代已停止 · 端口 ${provider.proxy.port}`);
        proxyInfo.append(dot, statusMsg);

        const btnAction = isRunning ? 'stop' : 'start';
        const btnLabel = isRunning ? '停止反代' : '启动反代';
        const ctrlBtn = button(btnLabel, async () => {
          ctrlBtn.disabled = true;
          ctrlBtn.textContent = isRunning ? '正在停止…' : '正在启动…';
          setStatus('providers-status', `正在${btnLabel} ${text(provider.name)}…`);
          try {
            const res = await request('/api/proxy/control', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: provider.id, action: btnAction }),
              timeout: 40000,
            });
            setStatus('providers-status', res.message || `${btnLabel}成功`);
            loadProviders(true);
          } catch (err) {
            setStatus('providers-status', err.message, true);
            ctrlBtn.disabled = false;
            ctrlBtn.textContent = btnLabel;
          }
        }, `proxy-btn ${isRunning ? '' : 'primary'}`);

        proxyBox.append(proxyInfo, ctrlBtn);
        card.append(proxyBox);
      }
      if (provider.enabled === false) card.append(el('p', 'meta', '服务商已禁用 · 仍显示已有配置和可用额度'));
      if (quota.plan) card.append(el('p', 'meta', `订阅 / 方案：${text(quota.plan)}`));
      if (quota.message) card.append(el('p', quota.status === 'error' ? 'meta error' : 'meta', quota.message));
      const windows = list(quota.windows);
      windows.forEach((window) => {
        const block = el('div', 'quota-window');
        const top = el('div', 'quota-top');
        const remaining = number(window.remainingPercent);
        const used = number(window.usedPercent);
        // Quota percentages are 0–100; context/cache ratios elsewhere are 0–1.
        const value = remaining !== null ? `${decimal.format(remaining)}% 剩余` : used !== null ? `${decimal.format(used)}% 已用` : '比例未知';
        top.append(el('span', 'meta', text(window.label ?? window.id)), el('span', 'quota-value', value));
        block.append(top);
        if (remaining !== null || used !== null) block.append(meter((used ?? (100 - remaining)) / 100));
        if (number(window.remaining) !== null || number(window.total) !== null) block.append(el('p', 'meta', `剩余 ${fmt(window.remaining)} / 总量 ${fmt(window.total)} ${text(window.unit, '')}`));
        const ts = resetTimestamp(window.resetAt);
        if (ts !== null) {
          const timer = el('p', 'meta', countdown(ts));
          timer.dataset.resetAt = String(ts);
          block.append(timer, el('p', 'meta', `重置于 ${dateTime(ts)}`));
        } else block.append(el('p', 'meta', '服务商未提供重置时间'));
        card.append(block);
      });
      list(quota.balances).forEach((balance) => card.append(el('p', 'balance', `余额 ${number(balance.remaining) === null ? '—' : decimal.format(balance.remaining)} ${text(balance.currency, '')}`)));
      if (!windows.length && !list(quota.balances).length && quota.status === 'ok') card.append(el('p', 'meta', '服务商未返回可展示的额度窗口或余额。'));
      list(quota.details).slice(0, 6).forEach((detail) => { if (typeof detail === 'string') card.append(el('p', 'meta', detail)); });
      card.append(el('p', 'meta', `来源：${text(quota.source, '服务商')} · 更新 ${dateTime(quota.asOfMs)}`));
      return card;
    });
    replace('providers', ...cards);
  }
  function updateProviderFilter() {
    const select = $('provider-filter');
    const current = select.value;
    const all = el('option', '', '全部服务商');
    all.value = '';
    select.replaceChildren(all);
    list(state.providers?.providers).forEach((provider) => {
      const option = el('option', '', text(provider.name ?? provider.id));
      option.value = text(provider.id);
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  function configuredRows() {
    const providers = list(state.providers?.providers);
    const query = $('configured-search').value.trim().toLocaleLowerCase();
    const filter = $('provider-filter').value;
    return providers.flatMap((p) => list(p.models).map((m) => ({ provider: p, model: m })))
      .filter(({ provider: p, model: m }) => (!filter || text(p.id) === filter) && matches(query, p.name, p.id, m.id, m.name))
      .sort((a, b) => (number(b.model.localUsage?.billedTokens) ?? -1) - (number(a.model.localUsage?.billedTokens) ?? -1));
  }
  function renderConfigured() {
    if (!state.providers) return;
    const rows = configuredRows();
    const visible = pageRows('configured', rows, renderConfigured);
    if (!visible.length) { replace('configured-table', empty('没有符合条件的配置模型。')); return; }
    const cells = visible.map(({ provider, model }) => {
      const name = el('div', '', text(model.name ?? model.id));
      if (model.name && model.name !== model.id) name.append(el('span', 'cell-sub mono', text(model.id)));
      const enabled = model.enabled !== false && provider.enabled !== false;
      const status = el('span', 'badge', enabled ? '启用' : '禁用');
      const usage = model.localUsageStatus === 'exact' && model.localUsage ? model.localUsage : null;
      const attribution = usage ? `${fmt(usage.calls)} 次请求 · 精确归属` : state.providers.localUsageStatus === 'error' ? '读取失败' : '暂无可归属记录';
      return [name, text(provider.name ?? provider.id), status, fmt(model.contextWindow), attribution,
        usage ? fmt(usage.inputTokens) : '—', usage ? fmt(usage.outputTokens) : '—',
        usage ? fmt(usage.cacheReadTokens) : '—', usage ? fmt(usage.billedTokens) : '—', usage ? pct(usage.cacheHitRate) : '—'];
    });
    replace('configured-table', makeTable(['配置模型', '服务商', '状态', '上下文窗口', '可归属记录', '未缓存输入', '输出', '缓存读取', '输入 + 输出', '缓存命中'], cells));
  }
  function renderCoverage() {
    const overview = state.overview;
    const k = overview.kpi ?? {};
    const context = overview.context ?? {};
    $('coverage-note').textContent = `记录区间：${dateTime(k.firstTsMs)} 至 ${dateTime(k.lastTsMs)}。上下文：${context.available ? `${fmt(context.samples)} 个采样，覆盖 ${fmt(context.sessions)} 个会话` : '无可用采样'}。仅能展示已记录的数据，缺失记录不补零。`;
  }
  async function loadOverview() {
    const seq = ++state.overviewSeq;
    $('refresh').disabled = true;
    $('overview-retry').hidden = true;
    $('kpis').setAttribute('aria-busy', 'true');
    setStatus('overview-status', state.overview ? '正在刷新本机统计，暂保留上次数据…' : '正在读取本机统计…');
    try {
      const data = await request(`/api/overview?range=${encodeURIComponent(state.range)}`);
      if (seq !== state.overviewSeq) return;
      if (!data.kpi || !Array.isArray(data.models)) throw new Error('本机统计数据不完整，请重试。');
      state.overview = data;
      renderKpis(); renderTrend(); renderPressure(); renderModels(); renderCoverage();
      setStatus('overview-status', `本机统计更新于 ${dateTime(data.generatedAtMs)}`);
    } catch (error) {
      if (seq !== state.overviewSeq) return;
      setStatus('overview-status', `${error.message}${state.overview ? ' 当前保留上次统计。' : ''}`, true);
      $('overview-retry').hidden = false;
      if (!state.overview) {
        ['trend', 'pressure', 'models-table'].forEach((id) => replace(id, empty('本机统计加载失败，请点击“重试用量”。')));
        $('coverage-note').textContent = '本机统计尚未加载，当前没有可核对的数据。';
      }
    } finally {
      if (seq === state.overviewSeq) { $('refresh').disabled = false; $('kpis').setAttribute('aria-busy', 'false'); }
    }
  }
  async function loadProviders(force = false) {
    const seq = ++state.providerSeq;
    $('quota-refresh').disabled = true;
    $('providers-retry').hidden = true;
    $('providers').setAttribute('aria-busy', 'true');
    setStatus('providers-status', state.providers ? '正在更新账户额度，暂保留上次结果…' : '正在查询账户，可能需要约 20 秒；本机统计独立加载。');
    try {
      const query = new URLSearchParams({ range: state.range });
      if (force) query.set('refresh', '1');
      const data = await request(`/api/providers?${query}`, { timeout: 60000 });
      if (seq !== state.providerSeq) return;
      if (!Array.isArray(data.providers)) throw new Error('服务商数据不完整，请重试。');
      state.providers = data;
      renderProviders(); updateProviderFilter(); renderConfigured();
      setStatus('providers-status', `查询完成于 ${dateTime(data.generatedAtMs)} · 手动刷新最短 20 秒${data.localUsageStatus === 'error' ? ' · 本机模型归属读取失败' : ` · ${fmt(data.unassignedCalls)} 次旧记录或历史模型调用未归属到当前配置`}`, data.localUsageStatus === 'error');
    } catch (error) {
      if (seq !== state.providerSeq) return;
      setStatus('providers-status', `${error.message}${state.providers ? ' 当前保留上次额度。' : ''}`, true);
      $('providers-retry').hidden = false;
      if (!state.providers) {
        replace('providers', empty('账户查询未完成，不影响本机用量。请重试账户查询。'));
        replace('configured-table', empty('配置模型暂未加载，请重试账户查询。'));
      }
    } finally {
      if (seq === state.providerSeq) { $('quota-refresh').disabled = false; $('providers').setAttribute('aria-busy', 'false'); }
    }
  }
  async function exportJson() {
    $('export').disabled = true;
    setStatus('export-status', '正在准备 JSON…');
    try {
      const range = state.range;
      const data = await request(`/api/export?range=${encodeURIComponent(range)}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = el('a');
      link.href = url;
      link.download = `model-usage-${range}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('export-status', `JSON 已准备（${fmt(blob.size)} 字节）`);
    } catch (error) { setStatus('export-status', error.message, true); }
    finally { $('export').disabled = false; }
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() { document.documentElement.dataset.theme = $('theme').value === 'system' ? (media.matches ? 'dark' : 'light') : $('theme').value; }
  $('theme').addEventListener('change', applyTheme);
  media.addEventListener('change', () => { if ($('theme').value === 'system') applyTheme(); });
  $('range').addEventListener('change', () => {
    state.range = $('range').value;
    state.pages.models = state.pages.configured = 0;
    // Never label old-range values as the newly selected range.
    state.overview = null;
    state.providers = null;
    ['kpi-calls', 'kpi-tokens', 'kpi-cache', 'kpi-sessions'].forEach((id) => { $(id).textContent = '—'; });
    $('kpi-cache-note').textContent = '缓存读取单独统计';
    $('kpi-turns').textContent = '所选范围内的会话';
    ['trend', 'pressure', 'models-table'].forEach((id) => replace(id, empty('正在加载所选范围…')));
    ['models-pager', 'configured-pager'].forEach((id) => replace(id));
    replace('configured-table', empty('正在加载所选范围的可归属用量…'));
    replace('providers', empty('正在更新账户快照…'));
    $('coverage-note').textContent = '正在读取所选范围的覆盖情况。';
    loadOverview();
    loadProviders();
  });
  $('refresh').addEventListener('click', () => { loadOverview(); loadProviders(); });
  $('overview-retry').addEventListener('click', loadOverview);
  $('quota-refresh').addEventListener('click', () => loadProviders(true));
  $('providers-retry').addEventListener('click', () => loadProviders(true));
  $('export').addEventListener('click', exportJson);
  [['model-search', 'models', renderModels], ['configured-search', 'configured', renderConfigured]].forEach(([id, key, render]) => {
    $(id).addEventListener('input', () => { state.pages[key] = 0; render(); });
  });
  $('provider-filter').addEventListener('change', () => { state.pages.configured = 0; renderConfigured(); });
  const tabs = ['overview', 'accounts'];
  function selectTab(name, focus = false) {
    tabs.forEach((key) => {
      const selected = key === name;
      $(`tab-${key}`).setAttribute('aria-selected', String(selected));
      $(`tab-${key}`).tabIndex = selected ? 0 : -1;
      $(`view-${key}`).hidden = !selected;
    });
    if (focus) $(`tab-${name}`).focus();
  }
  tabs.forEach((name, index) => {
    $(`tab-${name}`).addEventListener('click', () => selectTab(name));
    $(`tab-${name}`).addEventListener('keydown', (event) => {
      const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : null;
      if (target) { event.preventDefault(); selectTab(target, true); }
    });
  });
  setInterval(() => {
    document.querySelectorAll('[data-reset-at]').forEach((node) => { node.textContent = countdown(Number(node.dataset.resetAt)); });
  }, 30000);
  applyTheme();
  // Independent requests: slow account probes must not delay local usage rendering.
  loadOverview();
  loadProviders();
})();
