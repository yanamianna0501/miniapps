// Context dashboard Client: fetches the read-only overview and session detail from the board's
// Node service and renders them. No business state lives here; only view preferences.

const STORAGE_KEY = 'context-dashboard:view';
const RANGES = ['7d', '30d', 'all'];
const SORTS = ['recent', 'billed', 'context', 'pressure', 'rate'];
const SCOPES = ['global', 'session'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DETAIL_PAGE_SIZE = 200;
const COMPONENT_SWATCH = {
  SYSTEM_PROMPT: 'sys',
  MEMORY: 'mem',
  TOOLS: 'tools',
  SKILLS: 'skills',
  MESSAGES: 'msg',
  OTHER: 'other',
};

const state = {
  range: '7d',
  sort: 'recent',
  search: '',
  scope: 'global',
  overview: null,
  selectedSessionId: null,
  busy: false,
  error: null,
  detail: { sessionId: null, offset: 0, payload: null, loading: false, error: null },
};

const dom = {
  refresh: document.getElementById('refresh'),
  export: document.getElementById('export'),
  exportNote: document.getElementById('export-note'),
  notice: document.getElementById('notice'),
  degrade: document.getElementById('degrade'),
  coverage: document.getElementById('coverage'),
  sort: document.getElementById('sort'),
  search: document.getElementById('search'),
  segmented: [...document.querySelectorAll('.segmented__item[data-range]')],
  scopeSegmented: [...document.querySelectorAll('.segmented__item[data-scope]')],
  kpi: {
    sessions: document.getElementById('kpi-sessions'),
    sessionsHint: document.getElementById('kpi-sessions-hint'),
    billed: document.getElementById('kpi-billed'),
    billedHint: document.getElementById('kpi-billed-hint'),
    cacheRead: document.getElementById('kpi-cache-read'),
    cacheReadHint: document.getElementById('kpi-cache-read-hint'),
    hitRate: document.getElementById('kpi-hit-rate'),
    hitRateHint: document.getElementById('kpi-hit-rate-hint'),
  },
  dailyMeta: document.getElementById('daily-meta'),
  dailyChart: document.getElementById('daily-chart'),
  dailyTable: document.getElementById('daily-table'),
  pressureMeta: document.getElementById('pressure-meta'),
  pressureList: document.getElementById('pressure-list'),
  pressureNote: document.getElementById('pressure-note'),
  compositionMeta: document.getElementById('composition-meta'),
  compositionBar: document.getElementById('composition-bar'),
  compositionLegend: document.getElementById('composition-legend'),
  compositionTable: document.getElementById('composition-table'),
  compositionNote: document.getElementById('composition-note'),
  modelsMeta: document.getElementById('models-meta'),
  modelsTable: document.getElementById('models-table'),
  modelsNote: document.getElementById('models-note'),
  heatMeta: document.getElementById('heat-meta'),
  heatmap: document.getElementById('heatmap'),
  heatNote: document.getElementById('heat-note'),
  sessionsMeta: document.getElementById('sessions-meta'),
  sessionList: document.getElementById('session-list'),
  sessionsNote: document.getElementById('sessions-note'),
  detailPanel: document.getElementById('detail-panel'),
  detailMeta: document.getElementById('detail-meta'),
  detailGrowth: document.getElementById('detail-growth'),
  detailGrowthMeta: document.getElementById('detail-growth-meta'),
  detailTable: document.getElementById('detail-table'),
  detailPager: document.getElementById('detail-pager'),
  detailClose: document.getElementById('detail-close'),
  copyDialog: document.getElementById('copy-dialog'),
  copyText: document.getElementById('copy-text'),
  copyButton: document.getElementById('copy-button'),
  copyHint: document.getElementById('copy-hint'),
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

function formatInt(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

function formatCompact(value) {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) return '—';
  if (Math.abs(count) >= 1e8) return `${(count / 1e8).toFixed(2)} 亿`;
  if (Math.abs(count) >= 1e4) return `${(count / 1e4).toFixed(1)} 万`;
  return formatInt(count);
}

function formatRate(rate) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function formatRatio(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  return ratio >= 0.1 ? `${(ratio * 100).toFixed(1)}%` : `${(ratio * 100).toFixed(2)}%`;
}

function formatPoints(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}pp`;
}

function formatDateTime(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClock(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDayShort(day) {
  return day.slice(5);
}

function shortPath(value) {
  if (!value) return '—';
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return value;
  return `…\\${parts.slice(-2).join('\\')}`;
}

function rangeLabel(range = state.range) {
  return range === 'all' ? '全部历史' : `近 ${range === '7d' ? '7' : '30'} 天（自然日）`;
}

function readPreferences() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (RANGES.includes(parsed.range)) state.range = parsed.range;
    if (SORTS.includes(parsed.sort)) state.sort = parsed.sort;
    if (SCOPES.includes(parsed.scope)) state.scope = parsed.scope;
  } catch {
    /* keep defaults */
  }
}

function writePreferences() {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ range: state.range, sort: state.sort, scope: state.scope }),
    );
  } catch {
    /* view preferences are optional */
  }
}

function syncControls() {
  for (const button of dom.segmented) {
    button.setAttribute('aria-pressed', String(button.dataset.range === state.range));
  }
  for (const button of dom.scopeSegmented) {
    button.setAttribute('aria-pressed', String(button.dataset.scope === state.scope));
    if (button.dataset.scope === 'session') button.disabled = !state.selectedSessionId;
  }
  dom.sort.value = state.sort;
  if (dom.search.value !== state.search) dom.search.value = state.search;
  dom.refresh.disabled = state.busy;
  dom.export.disabled = state.busy || !state.overview;
}

function setNotice(message, tone = 'info') {
  dom.notice.textContent = message;
  dom.notice.className = tone === 'error' ? 'notice notice--error' : 'notice';
  dom.notice.hidden = !message;
}

function setDegrade(message) {
  dom.degrade.textContent = message ?? '';
  dom.degrade.hidden = !message;
}

function setExportNote(node) {
  dom.exportNote.replaceChildren();
  dom.exportNote.hidden = !node;
  if (node) dom.exportNote.append(node);
}

async function load() {
  state.busy = true;
  state.error = null;
  syncControls();
  setNotice('正在读取用量库…');
  setExportNote(null);
  try {
    const response = await fetch(`/api/overview?range=${encodeURIComponent(state.range)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`overview request failed with ${response.status}`);
    const payload = await response.json();
    state.overview = payload;
    renderOverview();
    setNotice('');
    const context = payload.context ?? {};
    setDegrade(context.available === false ? `上下文遥测不可用，已降级：${context.degradedReason ?? '未知原因'}` : null);
    if (state.selectedSessionId) {
      const stillPresent = payload.sessions.some((item) => item.sessionId === state.selectedSessionId);
      if (stillPresent) await loadSession(state.selectedSessionId, state.detail.offset);
      else closeDetail();
    }
  } catch (error) {
    state.error = String(error?.message ?? error);
    setNotice(`读取失败：${state.error}。请先确认 MiniMax Code 正在运行，再点「刷新数据」。`, 'error');
    dom.coverage.textContent = '';
  } finally {
    state.busy = false;
    syncControls();
  }
}

function renderOverview() {
  const payload = state.overview;
  if (!payload) return;
  renderKpi(payload);
  renderDaily(payload);
  renderPressure(payload);
  renderComposition(payload);
  renderModels(payload);
  renderHeatmap(payload);
  renderSessions(payload);
}

function renderKpi(payload) {
  const kpi = payload.kpi;
  dom.kpi.sessions.textContent = formatInt(kpi.sessions);
  dom.kpi.sessionsHint.textContent = `${formatInt(kpi.calls)} 次调用 · ${formatInt(kpi.turns)} 轮`;

  dom.kpi.billed.textContent = formatCompact(kpi.billedTokens);
  dom.kpi.billed.title = `${formatInt(kpi.billedTokens)} token`;
  dom.kpi.billedHint.textContent = `未缓存输入 ${formatCompact(kpi.inputTokens)} · 输出 ${formatCompact(kpi.outputTokens)}`;

  dom.kpi.cacheRead.textContent = formatCompact(kpi.cacheReadTokens);
  dom.kpi.cacheRead.title = `${formatInt(kpi.cacheReadTokens)} token`;
  dom.kpi.cacheReadHint.textContent = `缓存写入 ${formatCompact(kpi.cacheWriteTokens)} · 推理 ${formatCompact(kpi.reasoningTokens)}`;

  dom.kpi.hitRate.textContent = formatRate(kpi.cacheHitRate);
  dom.kpi.hitRateHint.textContent = '缓存读取 ÷（缓存读取 + 未缓存输入）';

  const parts = [`范围 ${rangeLabel()}`];
  if (kpi.firstTsMs) parts.push(`首条记录 ${formatDateTime(kpi.firstTsMs)}`);
  if (kpi.lastTsMs) parts.push(`末条记录 ${formatDateTime(kpi.lastTsMs)}`);
  const source = payload.source ?? {};
  if (source.driver) parts.push(`读取方式 ${source.driver}`);
  if (source.jsonSupport === false) parts.push('JSON 能力不可用（已降级解析）');
  if (source.dataDir) parts.push(`数据目录 ${source.dataDir}`);
  const coverage = payload.coverage ?? {};
  if (coverage.invariantViolated) parts.push('⚠ 图表与总量口径不一致');
  if (coverage.windowRowsTruncated) parts.push('⚠ 明细行数触及上限');
  dom.coverage.textContent = parts.join(' · ');
}

function buildChartColumn(day, maxTotal) {
  const total = day.cacheReadTokens + day.inputTokens + day.outputTokens;
  const title =
    `${day.date} · 调用 ${formatInt(day.calls)} 次\n` +
    `缓存读取 ${formatInt(day.cacheReadTokens)}\n` +
    `未缓存输入 ${formatInt(day.inputTokens)}\n` +
    `输出 ${formatInt(day.outputTokens)}`;
  const column = el('div', { class: 'chart__col', title });
  if (total <= 0) {
    column.append(el('div', { class: 'chart__empty' }));
    return column;
  }
  const heightPercent = Math.max(1, (total / maxTotal) * 100);
  const bar = el('div', { class: 'chart__bar', style: { height: `${heightPercent}%` } });
  const segments = [
    ['cache', day.cacheReadTokens],
    ['input', day.inputTokens],
    ['output', day.outputTokens],
  ];
  for (const [kind, value] of segments) {
    if (value <= 0) continue;
    bar.append(
      el('div', {
        class: `chart__seg--${kind}`,
        style: { height: `${Math.max(value / total * 100, 1)}%` },
      }),
    );
  }
  column.append(bar);
  return column;
}

function renderDaily(payload) {
  const days = payload.daily;
  const maxTotal = Math.max(1, ...days.map((day) => day.cacheReadTokens + day.inputTokens + day.outputTokens));
  const chart = document.createDocumentFragment();
  const labelEvery = days.length > 10 ? Math.ceil(days.length / 7) : 1;
  days.forEach((day, index) => {
    const column = buildChartColumn(day, maxTotal);
    const showLabel = index % labelEvery === 0 || index === days.length - 1;
    column.append(el('span', { class: 'chart__label', text: showLabel ? formatDayShort(day.date) : '' }));
    chart.append(column);
  });
  dom.dailyChart.replaceChildren(chart);
  dom.dailyChart.setAttribute(
    'aria-label',
    `每日 token 用量堆叠柱状图，共 ${days.length} 天，峰值 ${formatCompact(maxTotal)} token`,
  );

  const activeDays = days.filter((day) => day.calls > 0);
  const coverage = payload.coverage ?? {};
  const spanNote = coverage.chartTruncated ? `（仅显示近 ${days.length} 天，更早记录未入图）` : '';
  dom.dailyMeta.textContent = activeDays.length
    ? `${rangeLabel()} · ${activeDays.length} 天有调用 · 峰值 ${formatCompact(maxTotal)} token ${spanNote}`.trim()
    : `${rangeLabel()}没有调用记录`;

  const head = el('tr', {}, [
    el('th', { text: '日期' }),
    el('th', { class: 'num', text: '调用' }),
    el('th', { class: 'num', text: '缓存读取' }),
    el('th', { class: 'num', text: '未缓存输入' }),
    el('th', { class: 'num', text: '输出' }),
    el('th', { class: 'num', text: '命中率' }),
  ]);
  const body = el('tbody', {}, days.map((day) => {
    const denominator = day.cacheReadTokens + day.inputTokens;
    return el('tr', {}, [
      el('td', { text: day.date }),
      el('td', { class: 'num', text: formatInt(day.calls) }),
      el('td', { class: 'num', text: formatInt(day.cacheReadTokens) }),
      el('td', { class: 'num', text: formatInt(day.inputTokens) }),
      el('td', { class: 'num', text: formatInt(day.outputTokens) }),
      el('td', { class: 'num', text: formatRate(denominator ? day.cacheReadTokens / denominator : null) }),
    ]);
  }));
  dom.dailyTable.replaceChildren(
    el('table', {}, [el('caption', { text: `每日数值（共 ${days.length} 天，自然日口径）` }), el('thead', {}, [head]), body]),
  );
}

function pressureClass(ratio) {
  if (ratio === null || ratio === undefined) return '';
  if (ratio >= 0.75) return ' pressure__fill--full';
  if (ratio >= 0.5) return ' pressure__fill--high';
  return '';
}

function buildPressureRow(item, context) {
  const title = item.title || '(未命名会话)';
  const value = context
    ? `${formatCompact(context.usedTokens)} / ${formatCompact(context.windowTokens)}`
    : '无上下文遥测';
  const row = el('div', { class: 'pressure' }, [
    el('div', { class: 'pressure__head' }, [
      el('h3', { class: 'pressure__title', text: title, title: `${title}\n${item.workspaceDir ?? ''}` }),
      el('span', {
        class: 'pressure__value',
        text: context ? `${value} · ${formatRatio(context.ratio)}` : value,
      }),
    ]),
  ]);

  const track = el('div', { class: 'pressure__track' });
  if (context && context.ratio !== null) {
    track.append(
      el('div', {
        class: `pressure__fill${pressureClass(context.ratio)}`,
        style: { width: `${Math.min(context.ratio * 100, 100).toFixed(2)}%` },
      }),
    );
  }
  if (context && context.peakRatio !== null && context.peakRatio > (context.ratio ?? 0)) {
    track.append(
      el('div', {
        class: 'pressure__peak',
        style: { left: `${Math.min(context.peakRatio * 100, 99.5).toFixed(2)}%` },
        title: `峰值 ${formatCompact(context.peakUsedTokens)} token（${formatDateTime(context.peakTsMs)}）`,
      }),
    );
  }
  row.append(track);

  const meta = [];
  if (context) {
    meta.push(`峰值 ${formatCompact(context.peakUsedTokens)}（${formatDateTime(context.peakTsMs)}）`);
    if (context.model) meta.push(`模型 ${context.model}`);
    if (context.samples) meta.push(`${formatInt(context.samples)} 条快照`);
    if (context.divergenceRate !== null && context.divergenceRate !== undefined) {
      meta.push(`本地/供应商偏差 ${(context.divergenceRate * 100).toFixed(2)}%`);
    }
  } else {
    meta.push('该会话在所选范围内没有上下文快照');
  }
  row.append(el('p', { class: 'pressure__meta', text: meta.join(' · ') }));
  return row;
}

function renderPressure(payload) {
  const context = payload.context ?? {};
  const items = visibleSessions();
  const withContext = items.filter((item) => context.perSession?.[item.sessionId]);
  let peakItem = null;
  for (const item of withContext) {
    const entry = context.perSession[item.sessionId];
    if (!peakItem || (entry.ratio ?? 0) > (context.perSession[peakItem.sessionId].ratio ?? 0)) peakItem = item;
  }

  if (!items.length) {
    dom.pressureList.replaceChildren(
      el('p', { class: 'empty', text: payload.sessions.length ? '没有匹配的会话。' : '所选范围内还没有任何会话用过模型。' }),
    );
  } else {
    dom.pressureList.replaceChildren(
      ...items.map((item) => buildPressureRow(item, context.perSession?.[item.sessionId] ?? null)),
    );
  }

  const global = context.global ?? {};
  dom.pressureMeta.textContent = context.available
    ? `${formatInt(context.sessions ?? 0)} 个会话 · 合计占用 ${formatCompact(global.usedTokens)} / ${formatCompact(global.windowTokens)} · 各会话占用均值 ${formatRatio(global.avgRatio)}`
    : '上下文遥测不可用';

  const notes = [];
  if (context.available) {
    notes.push(
      '占用率 = 该会话最近一次模型调用的上下文已用 token ÷ 该次调用的上下文窗口上限；灰线为所选范围内峰值。',
    );
    if (peakItem) {
      const entry = context.perSession[peakItem.sessionId];
      notes.push(`范围内容量占用最高：${peakItem.title || '(未命名会话)'} ${formatRatio(entry.peakRatio)}。`);
    }
    if ((context.truncatedSessions ?? []).length) {
      notes.push(`${formatInt(context.truncatedSessions.length)} 个会话快照过多，仅取最近一批。`);
    }
    if (context.componentsLoaded === false) notes.push('组件明细未取到，构成面板可能为空。');
  } else if (context.degradedReason) {
    notes.push(`降级原因：${context.degradedReason}`);
  }
  dom.pressureNote.textContent = notes.join(' ');
}

function compositionSource(payload) {
  const context = payload.context ?? {};
  if (!context.available) return { error: '上下文遥测不可用' };
  if (state.scope === 'session') {
    const sessionId = state.selectedSessionId;
    if (!sessionId) return { error: '先在上方会话列表中点选一个会话' };
    const entry = context.perSession?.[sessionId];
    if (!entry) return { error: '该会话在所选范围内没有上下文快照' };
    const session = payload.sessions.find((item) => item.sessionId === sessionId);
    return {
      components: entry.components ?? [],
      total: entry.usedTokens,
      windowTokens: entry.windowTokens,
      ratio: entry.ratio,
      label: session?.title || '(未命名会话)',
      globalComponents: context.global?.components ?? [],
      globalTotal: context.global?.usedTokens ?? 0,
    };
  }
  return {
    components: context.global?.components ?? [],
    total: context.global?.usedTokens ?? 0,
    windowTokens: context.global?.windowTokens ?? 0,
    ratio: context.global?.ratio ?? null,
    label: `${formatInt(context.sessions ?? 0)} 个会话的最新快照合计`,
    globalComponents: context.global?.components ?? [],
    globalTotal: context.global?.usedTokens ?? 0,
  };
}

function renderComposition(payload) {
  const source = compositionSource(payload);
  const legend = dom.compositionLegend;
  legend.replaceChildren();

  if (source.error) {
    dom.compositionBar.className = 'composition-bar composition-bar--empty';
    dom.compositionBar.replaceChildren(document.createTextNode(source.error));
    dom.compositionBar.removeAttribute('role');
    dom.compositionTable.replaceChildren(el('p', { class: 'empty', text: source.error }));
    dom.compositionMeta.textContent = '';
    dom.compositionNote.textContent = '';
    return;
  }

  dom.compositionBar.className = 'composition-bar';
  dom.compositionBar.setAttribute('role', 'img');
  const total = Math.max(source.total, 1);
  dom.compositionBar.replaceChildren(
    ...source.components
      .filter((item) => item.tokens > 0)
      .map((item) =>
        el('div', {
          class: `composition-bar__seg seg--${COMPONENT_SWATCH[item.kind] ?? 'other'}`,
          style: { width: `${Math.max((item.tokens / total) * 100, 0.4).toFixed(2)}%` },
          title: `${item.label ?? item.kind} ${formatInt(item.tokens)} token（${formatRate(item.share)}）`,
        }),
      ),
  );
  dom.compositionBar.setAttribute(
    'aria-label',
    `上下文构成：${source.components.map((item) => `${item.label ?? item.kind} ${formatRate(item.share)}`).join('，')}`,
  );

  for (const item of source.components) {
    legend.append(
      el('li', { class: 'legend__item' }, [
        el('span', { class: `legend__swatch legend__swatch--${COMPONENT_SWATCH[item.kind] ?? 'other'}` }),
        document.createTextNode(`${item.label ?? item.kind} ${formatRate(item.share)}`),
      ]),
    );
  }

  const showDelta = state.scope === 'session';
  const globalShare = new Map((source.globalComponents ?? []).map((item) => [item.kind, item.share]));
  const head = el('tr', {}, [
    el('th', { text: '组件' }),
    el('th', { class: 'num', text: 'token' }),
    el('th', { class: 'num', text: '占比' }),
    showDelta ? el('th', { class: 'num', text: '全局占比' }) : null,
    showDelta ? el('th', { class: 'num', text: '差值' }) : null,
  ]);
  const body = el(
    'tbody',
    {},
    source.components.map((item) => {
      const cells = [
        el('td', { text: item.label ?? item.kind }),
        el('td', { class: 'num', text: formatInt(item.tokens) }),
        el('td', { class: 'num', text: formatRate(item.share) }),
      ];
      if (showDelta) {
        const base = globalShare.get(item.kind);
        cells.push(el('td', { class: 'num', text: formatRate(base) }));
        cells.push(
          el('td', {
            class: 'num',
            text:
              item.share === null || item.share === undefined || base === null || base === undefined
                ? '—'
                : formatPoints(item.share - base),
          }),
        );
      }
      return el('tr', {}, cells);
    }),
  );
  dom.compositionTable.replaceChildren(
    el('table', {}, [
      el('caption', { text: `上下文构成（${source.label}，合计 ${formatInt(source.total)} token）` }),
      el('thead', {}, [head]),
      body,
    ]),
  );

  dom.compositionMeta.textContent = `${source.label} · 合计 ${formatCompact(source.total)} / 窗口 ${formatCompact(source.windowTokens)} · 占用 ${formatRatio(source.ratio)}`;
  dom.compositionNote.textContent = showDelta
    ? '差值为该会话占比减去全局占比（百分点）；正值代表这一类在这个会话里比整体更重。'
    : '全局口径：每个会话取最近一次调用的组件快照后求和，反映"当前各处上下文里都装了什么"。';
}

function renderModels(payload) {
  const models = payload.models ?? [];
  const context = payload.context ?? {};
  if (!models.length) {
    dom.modelsTable.replaceChildren(
      el('p', {
        class: 'empty',
        text: context.available
          ? '所选范围内没有模型遥测记录。'
          : '模型名来自上下文遥测，当前不可用。',
      }),
    );
    dom.modelsMeta.textContent = '';
    dom.modelsNote.textContent = '';
    return;
  }

  const head = el('tr', {}, [
    el('th', { text: '模型' }),
    el('th', { class: 'num', text: '调用' }),
    el('th', { class: 'num', text: '会话' }),
    el('th', { class: 'num', text: '窗口' }),
    el('th', { class: 'num', text: '峰值占用' }),
    el('th', { class: 'num', text: '平均占用' }),
    el('th', { class: 'num', text: '未缓存输入' }),
    el('th', { class: 'num', text: '缓存读取' }),
    el('th', { class: 'num', text: '输出' }),
    el('th', { class: 'num', text: '命中率' }),
    el('th', { text: '校准' }),
  ]);
  const body = el(
    'tbody',
    {},
    models.map((model) =>
      el('tr', {}, [
        el('td', {
          text: model.telemetryMissing ? `${model.shortName}（无遥测归因）` : model.shortName,
          title: model.telemetryMissing
            ? '这些 token 所在轮次没有上下文遥测，无法归因到具体模型'
            : model.model,
        }),
        el('td', {
          class: 'num',
          text: model.telemetryMissing ? '—' : formatInt(model.calls),
          title: model.telemetryMissing ? '该桶只含 token 汇总，没有可归因的调用' : '',
        }),
        el('td', { class: 'num', text: model.telemetryMissing ? '—' : formatInt(model.sessions) }),
        el('td', { class: 'num', text: model.windowTokens ? formatCompact(model.windowTokens) : '—' }),
        el('td', {
          class: 'num',
          text: `${formatCompact(model.peakUsedTokens)}${model.peakRatio === null ? '' : `（${formatRatio(model.peakRatio)}）`}`,
        }),
        el('td', { class: 'num', text: formatCompact(model.avgUsedTokens) }),
        el('td', { class: 'num', text: formatCompact(model.inputTokens) }),
        el('td', { class: 'num', text: formatCompact(model.cacheReadTokens) }),
        el('td', { class: 'num', text: formatCompact(model.outputTokens) }),
        el('td', { class: 'num', text: formatRate(model.cacheHitRate) }),
        el('td', {
          class: 'mono',
          text: Object.entries(model.calibration ?? {}).map(([key, count]) => `${key}:${count}`).join(' ') || '—',
        }),
      ]),
    ),
  );
  dom.modelsTable.replaceChildren(
    el('table', {}, [
      el('caption', { text: `模型统计（共 ${models.length} 个模型，按调用数排序）` }),
      el('thead', {}, [head]),
      body,
    ]),
  );

  const calls = models.reduce((sum, model) => sum + model.calls, 0);
  dom.modelsMeta.textContent = `${models.length} 个模型 · ${formatInt(calls)} 条上下文遥测 · ${rangeLabel()}`;
  dom.modelsNote.textContent =
    '用量表的 model 字段在本机全为空，模型名取自每次调用的上下文遥测，按轮次（turn）归因；tokens 由用量表按同一轮次汇总。' +
    '缺少上下文遥测的调用其 token 单列为「无遥测归因」。缓存命中率口径与上方 KPI 一致。';
}

function levelFor(value, max) {
  if (value <= 0) return 0;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function renderHeatmap(payload) {
  const cells = payload.heatmap;
  const max = Math.max(1, ...cells.map((cell) => cell.billedTokens));
  const firstDate = new Date(`${cells[0].date}T00:00:00`);
  const leading = Number.isNaN(firstDate.getTime()) ? 0 : firstDate.getDay();

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < leading; index += 1) {
    fragment.append(el('span', { class: 'heatmap__pad' }));
  }
  for (const cell of cells) {
    const level = levelFor(cell.billedTokens, max);
    const weekday = WEEKDAYS[new Date(`${cell.date}T00:00:00`).getDay()] ?? '';
    fragment.append(
      el('span', {
        class: level === 0 ? 'heatmap__cell' : `heatmap__cell heatmap__cell--level-${level}`,
        title: `${cell.date}（周${weekday}）\n调用 ${formatInt(cell.calls)} 次\n输入 + 输出 ${formatInt(cell.billedTokens)} token\n缓存读取 ${formatInt(cell.cacheReadTokens)}`,
      }),
    );
  }
  dom.heatmap.replaceChildren(fragment);

  const active = cells.filter((cell) => cell.calls > 0);
  const peak = active.reduce((best, cell) => (cell.billedTokens > best.billedTokens ? cell : best), {
    date: '—',
    billedTokens: 0,
  });
  dom.heatMeta.textContent = `${cells[0].date} 起共 ${cells.length} 天（固定 8 周，与所选范围无关）`;
  dom.heatNote.textContent = active.length
    ? `8 周内 ${active.length} 天有调用，峰值 ${peak.date}（输入 + 输出 ${formatCompact(peak.billedTokens)} token）。`
    : '8 周内没有调用记录。';
  dom.heatmap.setAttribute(
    'aria-label',
    `近 8 周每日 token 热力图，${active.length} 天有调用，峰值 ${peak.date}`,
  );
}

function visibleSessions() {
  const payload = state.overview;
  if (!payload) return [];
  const keyword = state.search.trim().toLowerCase();
  const context = payload.context ?? {};
  let items = payload.sessions;
  if (keyword) {
    items = items.filter((item) =>
      [item.title, item.workspaceDir, item.sessionId, item.agentName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(keyword)),
    );
  }
  const sorted = [...items];
  if (state.sort === 'billed') sorted.sort((a, b) => b.billedTokens - a.billedTokens);
  else if (state.sort === 'context')
    sorted.sort((a, b) => (b.latestPrompt?.promptTokens ?? 0) - (a.latestPrompt?.promptTokens ?? 0));
  else if (state.sort === 'pressure')
    sorted.sort(
      (a, b) =>
        (context.perSession?.[b.sessionId]?.ratio ?? -1) - (context.perSession?.[a.sessionId]?.ratio ?? -1),
    );
  else if (state.sort === 'rate') sorted.sort((a, b) => (b.cacheHitRate ?? -1) - (a.cacheHitRate ?? -1));
  else sorted.sort((a, b) => (b.lastTsMs ?? 0) - (a.lastTsMs ?? 0));
  return sorted;
}

function renderSessions(payload) {
  const items = visibleSessions();
  const maxPrompt = Math.max(1, ...items.map((item) => item.latestPrompt?.promptTokens ?? 0));
  const context = payload.context ?? {};

  if (!items.length) {
    dom.sessionList.replaceChildren(
      el('p', {
        class: 'empty',
        text: payload.sessions.length
          ? '没有匹配的会话，换个关键词试试。'
          : '所选范围内还没有任何会话用过模型。等 MiniMax Code 跑过几轮后再刷新。',
      }),
    );
  } else {
    dom.sessionList.replaceChildren(
      ...items.map((item) => buildSessionCard(item, maxPrompt, context.perSession?.[item.sessionId] ?? null)),
    );
  }

  dom.sessionsMeta.textContent = `${items.length} 个会话 · ${rangeLabel()}`;
  const coverage = payload.coverage ?? {};
  const notes = [];
  if (coverage.sessionsWithoutUsage) {
    notes.push(`另有 ${formatInt(coverage.sessionsWithoutUsage)} 个会话在所选范围内没有 token 记录，未列出。`);
  }
  if (coverage.historyFloorMs) {
    notes.push(`用量库最早记录为 ${formatDateTime(coverage.historyFloorMs)}，此前的会话用量不在本机数据目录中。`);
  }
  dom.sessionsNote.textContent = notes.join('');
}

function buildSessionCard(item, maxPrompt, context) {
  const prompt = item.latestPrompt;
  const promptTokens = prompt?.promptTokens ?? 0;
  const cachePct = maxPrompt > 0 ? Math.max((prompt?.cacheReadTokens ?? 0) / maxPrompt * 100, promptTokens ? 0.5 : 0) : 0;
  const inputPct = maxPrompt > 0 ? Math.max((prompt?.inputTokens ?? 0) / maxPrompt * 100, promptTokens ? 0.5 : 0) : 0;

  const bar = el('div', { class: 'context-bar' }, [
    el('div', { class: 'context-bar__seg--cache', style: { width: `${cachePct}%` } }),
    el('div', { class: 'context-bar__seg--input', style: { width: `${inputPct}%` } }),
  ]);

  const children = [
    el('div', { class: 'session-card__top' }, [
      el('h3', { class: 'session-card__title', text: item.title || '(未命名会话)' }),
      el('span', { class: 'session-card__rate', text: formatRate(item.cacheHitRate) }),
    ]),
    el('p', { class: 'session-card__meta', text: `${shortPath(item.workspaceDir)} · ${formatDateTime(item.lastTsMs)}` }),
    el('p', {
      class: 'session-card__stats',
      text: `${formatInt(item.calls)} 次调用 · ${formatInt(item.turns)} 轮 · 输入 + 输出 ${formatCompact(item.billedTokens)}`,
    }),
    el('p', { class: 'session-card__stats', text: prompt ? `最近一次 prompt ${formatInt(promptTokens)} token` : '暂无 prompt 记录' }),
    bar,
  ];

  if (context) {
    const track = el('div', { class: 'pressure__track' }, [
      el('div', {
        class: `pressure__fill${pressureClass(context.ratio)}`,
        style: { width: `${Math.min((context.ratio ?? 0) * 100, 100).toFixed(2)}%` },
      }),
    ]);
    children.push(track);
    children.push(
      el('p', {
        class: 'session-card__stats',
        text: `上下文 ${formatCompact(context.usedTokens)} / ${formatCompact(context.windowTokens)} · ${formatRatio(context.ratio)} · 峰值 ${formatRatio(context.peakRatio)}`,
      }),
    );
  }

  const card = el(
    'button',
    {
      type: 'button',
      class: 'session-card',
      'data-session': item.sessionId,
      'aria-expanded': String(state.selectedSessionId === item.sessionId),
      title: [
        item.title ?? '(未命名会话)',
        item.workspaceDir ?? '',
        `会话 ${item.sessionId}`,
        prompt ? `最近一次调用 prompt ${formatInt(promptTokens)} token` : '',
        context ? `上下文占用 ${formatRatio(context.ratio)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    children,
  );
  card.addEventListener('click', () => {
    if (state.selectedSessionId === item.sessionId) closeDetail();
    else void selectSession(item.sessionId);
  });
  return card;
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  state.detail.offset = 0;
  state.scope = 'session';
  writePreferences();
  syncControls();
  renderComposition(state.overview);
  await loadSession(sessionId, 0);
}

function closeDetail() {
  state.selectedSessionId = null;
  state.detail = { sessionId: null, offset: 0, payload: null, loading: false, error: null };
  dom.detailPanel.hidden = true;
  for (const card of dom.sessionList.querySelectorAll('.session-card')) {
    card.setAttribute('aria-expanded', 'false');
  }
  // A session-scoped composition view has nothing to show once the selection is gone.
  if (state.scope === 'session') {
    state.scope = 'global';
    writePreferences();
  }
  syncControls();
  if (state.overview) renderComposition(state.overview);
}

async function loadSession(sessionId, offset = 0) {
  state.detail.sessionId = sessionId;
  state.detail.loading = true;
  dom.detailPanel.hidden = false;
  dom.detailMeta.textContent = '正在读取…';
  dom.detailTable.replaceChildren();
  dom.detailPager.replaceChildren();
  dom.detailGrowth.replaceChildren();
  dom.detailGrowthMeta.textContent = '';
  for (const card of dom.sessionList.querySelectorAll('.session-card')) {
    card.setAttribute('aria-expanded', String(card.dataset.session === sessionId));
  }
  try {
    const query = new URLSearchParams({
      sessionId,
      limit: String(DETAIL_PAGE_SIZE),
      offset: String(Math.max(offset, 0)),
      range: 'all',
    });
    const response = await fetch(`/api/session?${query.toString()}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`session request failed with ${response.status}`);
    const payload = await response.json();
    if (state.selectedSessionId !== sessionId) return;
    state.detail.offset = payload.page?.offset ?? Math.max(offset, 0);
    state.detail.payload = payload;
    state.detail.error = null;
    renderDetail(payload);
  } catch (error) {
    if (state.selectedSessionId !== sessionId) return;
    state.detail.error = String(error?.message ?? error);
    dom.detailMeta.textContent = `读取失败：${state.detail.error}`;
  } finally {
    state.detail.loading = false;
  }
}

function buildGrowthSvg(points, windowTokens) {
  const width = 600;
  const height = 140;
  const padTop = 12;
  const padBottom = 18;
  const plotWidth = width - 16;
  const plotHeight = height - padTop - padBottom;
  const peak = Math.max(1, ...points.map((point) => point.usedTokens));
  const useWindowLine = Boolean(windowTokens) && windowTokens <= peak * 1.6;
  const yMax = useWindowLine ? windowTokens : peak * 1.15;
  const timestamps = points.map((point) => point.tsMs);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const xOf = (ts) => (maxTs === minTs ? 8 + plotWidth / 2 : 8 + ((ts - minTs) / (maxTs - minTs)) * plotWidth);
  const yOf = (value) => padTop + plotHeight - (Math.min(value, yMax) / yMax) * plotHeight;

  const coords = points.map((point) => [xOf(point.tsMs), yOf(point.usedTokens)]);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} ${(8 + plotWidth).toFixed(1)},${(padTop + plotHeight).toFixed(1)} 8,${(padTop + plotHeight).toFixed(1)}`;
  const last = coords[coords.length - 1];

  const parts = [
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="presentation" focusable="false">`,
    `<line x1="8" y1="${padTop + plotHeight}" x2="${(8 + plotWidth).toFixed(1)}" y2="${padTop + plotHeight}" stroke="var(--mcode-border)" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
  ];
  if (useWindowLine) {
    const y = yOf(windowTokens).toFixed(1);
    parts.push(
      `<line x1="8" y1="${y}" x2="${(8 + plotWidth).toFixed(1)}" y2="${y}" stroke="var(--mcode-text-subtle)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>`,
    );
  }
  parts.push(
    `<polygon points="${area}" fill="var(--mcode-ctx-msg)" opacity="0.12"/>`,
    `<polyline points="${line}" fill="none" stroke="var(--mcode-ctx-msg)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`,
    `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--mcode-ctx-msg)"/>`,
    '</svg>',
  );
  return parts.join('');
}

function renderDetail(payload) {
  const meta = payload.meta ?? {};
  const totals = payload.totals;
  const page = payload.page ?? { limit: DETAIL_PAGE_SIZE, offset: 0, total: payload.calls.length };
  const context = payload.context ?? {};
  const title = meta.title || '(未命名会话)';
  const parts = [
    title,
    shortPath(meta.workspaceDir),
    `${formatInt(totals.calls)} 次调用 · ${formatInt(totals.turns)} 轮`,
    `输入 + 输出 ${formatInt(totals.billedTokens)} · 命中率 ${formatRate(totals.cacheHitRate)}`,
  ];
  if (context.available && context.latest) {
    parts.push(`当前上下文 ${formatCompact(context.latest.usedTokens)} / ${formatCompact(context.latest.windowTokens)}（${formatRatio(context.latest.ratio)}）`);
  }
  dom.detailMeta.textContent = parts.join(' · ');

  if (context.available && (context.series ?? []).length) {
    const series = context.series;
    dom.detailGrowth.innerHTML = buildGrowthSvg(series, context.latest?.windowTokens ?? null);
    dom.detailGrowth.setAttribute(
      'aria-label',
      `上下文占用折线图，共 ${series.length} 个点，最高 ${formatInt(context.peak?.usedTokens ?? 0)} token`,
    );
    const spans = [];
    if (context.samples) spans.push(`${formatInt(context.samples)} 条快照`);
    if (context.seriesDownsampled) spans.push('已抽稀显示');
    if (context.truncated) spans.push('仅取最近一批快照');
    if (context.latest?.model) spans.push(`模型 ${context.latest.model}`);
    dom.detailGrowthMeta.textContent = `${spans.join(' · ')}${spans.length ? ' · ' : ''}窗口上限 ${formatCompact(context.latest?.windowTokens)}`;
  } else {
    dom.detailGrowth.replaceChildren(
      el('p', { class: 'growth__empty', text: context.available ? '该会话没有上下文快照。' : `上下文遥测不可用：${context.degradedReason ?? '未知原因'}` }),
    );
    dom.detailGrowthMeta.textContent = '';
  }

  const head = el('tr', {}, [
    el('th', { text: '时间' }),
    el('th', { class: 'num', text: '未缓存输入' }),
    el('th', { class: 'num', text: '缓存读取' }),
    el('th', { class: 'num', text: '输出' }),
    el('th', { class: 'num', text: 'prompt 合计' }),
    el('th', { class: 'num', text: '命中率' }),
    el('th', { text: '轮次' }),
  ]);
  const body = el(
    'tbody',
    {},
    payload.calls.map((call) =>
      el('tr', {}, [
        el('td', { text: formatClock(call.tsMs) }),
        el('td', { class: 'num', text: formatInt(call.inputTokens) }),
        el('td', { class: 'num', text: formatInt(call.cacheReadTokens) }),
        el('td', { class: 'num', text: formatInt(call.outputTokens) }),
        el('td', { class: 'num', text: formatInt(call.promptTokens) }),
        el('td', { class: 'num', text: formatRate(call.cacheHitRate) }),
        el('td', { class: 'mono', text: call.turnId ? call.turnId.slice(0, 8) : '—' }),
      ]),
    ),
  );
  dom.detailTable.replaceChildren(
    el('table', {}, [
      el('caption', {
        text: `逐次模型调用（第 ${formatInt(page.offset + 1)}–${formatInt(page.offset + payload.calls.length)} 条，共 ${formatInt(page.total)} 条，按时间正序）`,
      }),
      el('thead', {}, [head]),
      body,
    ]),
  );
  renderPager(payload);
}

function renderPager(payload) {
  const page = payload.page ?? { limit: DETAIL_PAGE_SIZE, offset: 0, total: payload.calls.length, hasMore: false };
  const pageCount = Math.max(1, Math.ceil(page.total / page.limit));
  const current = Math.floor(page.offset / page.limit) + 1;
  const prev = el('button', {
    type: 'button',
    class: 'btn',
    text: '上一页',
    disabled: page.offset <= 0,
  });
  const next = el('button', {
    type: 'button',
    class: 'btn',
    text: '下一页',
    disabled: !page.hasMore,
  });
  prev.addEventListener('click', () => void loadSession(state.detail.sessionId, Math.max(page.offset - page.limit, 0)));
  next.addEventListener('click', () => void loadSession(state.detail.sessionId, page.offset + page.limit));
  dom.detailPager.replaceChildren(
    prev,
    el('p', { class: 'pager__info', text: `第 ${formatInt(current)} / ${formatInt(pageCount)} 页 · 每页 ${formatInt(page.limit)} 条` }),
    next,
  );
}

/* ------------------------------------------------------------------------------ CSV export */

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv() {
  const payload = state.overview;
  if (!payload) return null;
  const rows = [];
  const push = (...cells) => rows.push(cells.map(csvCell).join(','));
  const detail = state.detail.payload;

  push('# 上下文仪表盘导出');
  push('# 生成时间', formatDateTime(payload.generatedAtMs), '范围', rangeLabel(payload.range));
  push('# 读取方式', payload.source?.driver ?? '', '数据目录', payload.source?.dataDir ?? '');
  push('');
  push('[总览]');
  push('指标', '数值');
  push('会话数', payload.kpi.sessions);
  push('模型调用次数', payload.kpi.calls);
  push('轮次', payload.kpi.turns);
  push('未缓存输入 token', payload.kpi.inputTokens);
  push('输出 token', payload.kpi.outputTokens);
  push('缓存读取 token', payload.kpi.cacheReadTokens);
  push('缓存写入 token', payload.kpi.cacheWriteTokens);
  push('输入 + 输出 token', payload.kpi.billedTokens);
  push('缓存命中率', payload.kpi.cacheHitRate === null ? '' : payload.kpi.cacheHitRate.toFixed(6));
  push('');
  push('[每日用量]');
  push('日期', '调用', '缓存读取', '未缓存输入', '输出', '命中率');
  for (const day of payload.daily) {
    const denominator = day.cacheReadTokens + day.inputTokens;
    push(day.date, day.calls, day.cacheReadTokens, day.inputTokens, day.outputTokens, denominator ? (day.cacheReadTokens / denominator).toFixed(6) : '');
  }
  push('');
  push('[会话]');
  push('会话标题', '会话 ID', '工作区', '调用', '轮次', '未缓存输入', '输出', '缓存读取', '输入+输出', '命中率', '上下文已用', '窗口上限', '占用率', '峰值占用率', '最近一次调用');
  const context = payload.context ?? {};
  for (const item of payload.sessions) {
    const entry = context.perSession?.[item.sessionId];
    push(
      item.title ?? '',
      item.sessionId,
      item.workspaceDir ?? '',
      item.calls,
      item.turns,
      item.inputTokens,
      item.outputTokens,
      item.cacheReadTokens,
      item.billedTokens,
      item.cacheHitRate === null ? '' : item.cacheHitRate.toFixed(6),
      entry?.usedTokens ?? '',
      entry?.windowTokens ?? '',
      entry?.ratio === null || entry?.ratio === undefined ? '' : entry.ratio.toFixed(6),
      entry?.peakRatio === null || entry?.peakRatio === undefined ? '' : entry.peakRatio.toFixed(6),
      formatDateTime(item.lastTsMs),
    );
  }
  push('');
  push('[上下文构成]');
  push('范围', '组件', 'token', '占比');
  const globalComponents = context.global?.components ?? [];
  for (const item of globalComponents) {
    push(`${formatInt(context.sessions ?? 0)} 个会话最新合计`, item.label ?? item.kind, item.tokens, item.share === null ? '' : item.share.toFixed(6));
  }
  for (const [sessionId, entry] of Object.entries(context.perSession ?? {})) {
    const session = payload.sessions.find((item) => item.sessionId === sessionId);
    for (const item of entry.components ?? []) {
      push(session?.title ?? sessionId, item.label ?? item.kind, item.tokens, item.share === null ? '' : item.share.toFixed(6));
    }
  }
  push('');
  push('[模型统计]');
  push('模型', '调用', '会话', '窗口', '峰值占用', '平均占用', '未缓存输入', '缓存读取', '输出', '输入+输出', '命中率', '校准状态');
  for (const model of payload.models ?? []) {
    push(
      model.model,
      model.calls,
      model.sessions,
      model.windowTokens ?? '',
      model.peakUsedTokens,
      model.avgUsedTokens ?? '',
      model.inputTokens,
      model.cacheReadTokens,
      model.outputTokens,
      model.billedTokens,
      model.cacheHitRate === null ? '' : model.cacheHitRate.toFixed(6),
      Object.entries(model.calibration ?? {}).map(([key, count]) => `${key}:${count}`).join(' '),
    );
  }
  if (detail) {
    push('');
    push(`[逐次调用] ${detail.meta?.title ?? state.detail.sessionId}`);
    push('时间', '未缓存输入', '缓存读取', '输出', 'prompt 合计', '命中率', '轮次');
    for (const call of detail.calls) {
      push(
        formatClock(call.tsMs),
        call.inputTokens,
        call.cacheReadTokens,
        call.outputTokens,
        call.promptTokens,
        call.cacheHitRate === null ? '' : call.cacheHitRate.toFixed(6),
        call.turnId ?? '',
      );
    }
  }
  return { text: rows.join('\n'), name: `context-dashboard-${payload.range}-${stamp(new Date())}.csv` };
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function exportCsv() {
  const built = buildCsv();
  if (!built) {
    setNotice('还没有数据可导出，先点「刷新数据」。', 'error');
    return;
  }
  let downloaded = false;
  try {
    const blob = new Blob([`\uFEFF${built.text}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = built.name;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    downloaded = true;
  } catch {
    downloaded = false;
  }
  const button = el('button', { type: 'button', class: 'btn btn--ghost notice__action', text: '改用复制' });
  button.addEventListener('click', () => openCopyDialog(built.text, built.name));
  setExportNote(
    el('span', {
      text: downloaded
        ? `已导出 ${built.name}（${formatInt(built.text.split('\n').length)} 行）；若浏览器未保存文件，请点“改用复制”。`
        : `浏览器未接受文件下载，请点“改用复制”取走 CSV。`,
    }),
  );
  dom.exportNote.append(button);
}

function openCopyDialog(text, name) {
  dom.copyText.value = text;
  dom.copyHint.textContent = `${name} · 共 ${formatInt(text.split('\n').length)} 行。浏览器若未保存文件，可全选下方文本后复制。`;
  if (typeof dom.copyDialog.showModal === 'function' && !dom.copyDialog.open) dom.copyDialog.showModal();
}

async function copyCsvText() {
  dom.copyText.focus();
  dom.copyText.select();
  try {
    await navigator.clipboard.writeText(dom.copyText.value);
    dom.copyHint.textContent = '已复制到剪贴板。';
    return;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    document.execCommand('copy');
    dom.copyHint.textContent = '已复制到剪贴板。';
  } catch {
    dom.copyHint.textContent = '浏览器拒绝了自动复制，请手动全选（Ctrl+A）后复制。';
  }
}

dom.refresh.addEventListener('click', () => void load());
dom.export.addEventListener('click', exportCsv);
dom.copyButton.addEventListener('click', () => void copyCsvText());
dom.sort.addEventListener('change', () => {
  state.sort = SORTS.includes(dom.sort.value) ? dom.sort.value : 'recent';
  writePreferences();
  if (state.overview) {
    renderSessions(state.overview);
    renderPressure(state.overview);
  }
});
dom.search.addEventListener('input', () => {
  state.search = dom.search.value;
  if (state.overview) {
    renderSessions(state.overview);
    renderPressure(state.overview);
  }
});
dom.detailClose.addEventListener('click', closeDetail);
for (const button of dom.segmented) {
  button.addEventListener('click', () => {
    const next = button.dataset.range;
    if (!RANGES.includes(next) || next === state.range) return;
    state.range = next;
    writePreferences();
    syncControls();
    void load();
  });
}
for (const button of dom.scopeSegmented) {
  button.addEventListener('click', () => {
    const next = button.dataset.scope;
    if (!SCOPES.includes(next) || next === state.scope) return;
    state.scope = next;
    writePreferences();
    syncControls();
    if (state.overview) renderComposition(state.overview);
  });
}

readPreferences();
syncControls();
void load();
