import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDeepseek, parseCodex, parseGoogleAntigravity } from '../miniapp/node/quota.mjs';
import { isProxySupported, executeProxyControl } from '../miniapp/node/proxy-controller.mjs';
import { attachUsage } from '../miniapp/node/service.mjs';
import { rangeToSince, buildModelStats } from '../miniapp/node/usage-report.mjs';

test('zero balance is a verified value, not unknown', () => {
  const q = parseDeepseek({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] });
  assert.equal(q.status, 'ok');
  assert.equal(q.balances[0].remaining, 0);
});
test('missing balance, malformed amounts and empty records fail closed', () => {
  for (const amount of [undefined, null, '', ' ', false, {}, [], 'oops']) {
    assert.throws(() => parseDeepseek({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: amount }] }));
  }
  assert.throws(() => parseDeepseek({ is_available: true, balance_infos: [] }));
  assert.throws(() => parseDeepseek({}));
});
test('decimal credit balance is preserved', () => {
  assert.equal(parseDeepseek({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.89' }] }).balances[0].remaining, 3.89);
});
test('Codex zero-percent usage is valid and reset is milliseconds', () => {
  const q = parseCodex({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 0, reset_at: 1800000000 } } });
  assert.equal(q.windows[0].remainingPercent, 100);
  assert.equal(q.windows[0].resetAt, 1800000000000);
  assert.equal(q.windows.length, 1);
});
test('Codex absent/invalid windows cannot turn into 100% remaining', () => {
  for (const used of [undefined, null, '', ' ', false, -1, 101, 'NaN']) {
    assert.throws(() => parseCodex({ rate_limit: { primary_window: { used_percent: used } } }));
  }
  assert.throws(() => parseCodex({ rate_limit: {} }));
  assert.throws(() => parseCodex({ error: 'invalid account' }));
});
test('Codex unlimited credits do not fabricate a balance', () => {
  const q = parseCodex({ credits: { unlimited: true }, rate_limit: { primary_window: { used_percent: 70 } } });
  assert.deepEqual(q.balances, []);
});
test('same model on different providers never receives duplicate name-only usage', () => {
  const configs = ['a', 'b'].map(id => ({ id, name: id, enabled: true, apiKey: 'SYNTHETIC-ONLY', baseURL: 'https://example.invalid', models: [{ id: 'shared', name: 'shared', enabled: true }] }));
  const row = (model, calls) => ({ model, calls, inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, billedTokens: 6 });
  const result = attachUsage(configs, [row('custom_provider:a/shared', 2), row('shared', 5), row(null, 7)]);
  assert.equal(result.providers[0].models[0].localUsage.calls, 2);
  assert.equal(result.providers[1].models[0].localUsage, null);
  assert.equal(result.unassignedCalls, 12);
  const encoded = JSON.stringify(result);
  assert.ok(!encoded.includes('SYNTHETIC-ONLY'));
  assert.ok(!encoded.includes('baseURL'));
});
test('both historical qualified provider spellings are aggregated once', () => {
  const result = attachUsage([{ id: 'a', name: 'A', enabled: true, models: [{ id: 'x', enabled: false }] }], [
    { model: 'a/x', calls: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, billedTokens: 3 },
    { model: 'custom_provider:a/x', calls: 2, inputTokens: 4, outputTokens: 5, cacheReadTokens: 6, billedTokens: 9 },
  ]);
  assert.equal(result.providers[0].models[0].enabled, false);
  assert.equal(result.providers[0].models[0].localUsage.calls, 3);
  assert.equal(result.unassignedCalls, 0);
});
test('history model calls count usage rows, not context samples', () => {
  const source = { query: () => [{ model: 'a/x', turn_id: 't', input_tokens: 2, output_tokens: 3, cache_read_tokens: 0 }] };
  const snapshots = [1, 2].map(id => ({ id, turnId: 't', sessionId: 's', model: 'x', usedTokens: 10, windowTokens: 100 }));
  const [x] = buildModelStats(source, null, snapshots);
  assert.equal(x.calls, 1);
  assert.equal(x.samples, 2);
  assert.equal(x.billedTokens, 5);
});
test('qualified telemetry and token rows join into one history model', () => {
  const source = { query: () => [{ model: 'custom_provider:a/x', turn_id: 't', input_tokens: 2, output_tokens: 3, cache_read_tokens: 0 }] };
  const snapshots = [{ turnId: 't', sessionId: 's', model: 'custom_provider:a/x', usedTokens: 10, windowTokens: 100 }];
  const groups = buildModelStats(source, null, snapshots);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].model, 'x');
  assert.equal(groups[0].calls, 1);
  assert.equal(groups[0].samples, 1);
  assert.equal(groups[0].peakRatio, 0.1);
});
test('provider-qualified usage survives without context telemetry', () => {
  const source = { query: () => [{ model: 'a/x', input_tokens: 2, output_tokens: 3, cache_read_tokens: 4 }] };
  const [x] = buildModelStats(source, null, []);
  assert.equal(x.model, 'x');
  assert.equal(x.calls, 1);
  assert.equal(x.peakRatio, null);
  assert.equal(x.avgRatio, null);
});
test('ambiguous legacy turns are unknown instead of misattributed', () => {
  const source = { query: () => [{ model: null, turn_id: 't', input_tokens: 2, output_tokens: 3, cache_read_tokens: 0 }] };
  const snapshots = ['x', 'y'].map(model => ({ turnId: 't', sessionId: 's', model, usedTokens: 10, windowTokens: 100 }));
  const groups = buildModelStats(source, null, snapshots);
  assert.equal(groups.find(x => x.model === '未知模型').calls, 1);
  assert.equal(groups.find(x => x.model === 'x').calls, 0);
});
test('context ratios respect the window of each individual sample', () => {
  const snapshots = [{ turnId: 'a', sessionId: 's', model: 'x', usedTokens: 90, windowTokens: 100 }, { turnId: 'b', sessionId: 's', model: 'x', usedTokens: 200, windowTokens: 1000 }];
  const [x] = buildModelStats({ query: () => [] }, null, snapshots);
  assert.equal(x.peakRatio, 0.9);
  assert.equal(x.avgRatio, 0.55);
});
test('range boundaries use calendar days', () => {
  const now = new Date(2026, 9, 27, 0, 30).getTime();
  assert.equal(rangeToSince('7d', now), new Date(2026, 9, 21).getTime());
  assert.equal(rangeToSince('all', now), null);
});
test('Google Antigravity parses weekly limit and 5-hour limit accurately', () => {
  const summary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.7895, resetTime: '2026-10-30T06:40:28Z' },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.8295, resetTime: '2026-10-26T18:48:33Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9892, resetTime: '2026-10-30T13:34:32Z' },
          { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-10-26T21:28:16Z' },
        ],
      },
    ],
  };
  const q = parseGoogleAntigravity(summary, null);
  assert.equal(q.status, 'ok');
  assert.equal(q.windows.length, 4);
  assert.equal(q.windows[0].id, 'gemini-weekly');
  assert.equal(q.windows[0].label, 'Gemini 周额度');
  assert.equal(q.windows[0].remainingPercent, 79);
  assert.equal(q.windows[0].usedPercent, 21.1);
  assert.equal(q.windows[0].resetAt, Date.parse('2026-10-30T06:40:28Z'));
  assert.equal(q.windows[1].id, 'gemini-5h');
  assert.equal(q.windows[1].label, 'Gemini 5小时窗口');
  assert.equal(q.windows[1].remainingPercent, 83);
  assert.equal(q.windows[2].id, '3p-weekly');
  assert.equal(q.windows[2].label, 'Claude/GPT 周额度');
  assert.equal(q.windows[2].remainingPercent, 98.9);
  assert.equal(q.windows[3].id, '3p-5h');
  assert.equal(q.windows[3].label, 'Claude/GPT 5小时窗口');
  assert.equal(q.windows[3].remainingPercent, 100);
});
test('Google Antigravity fails closed on invalid fractions or missing windows', () => {
  assert.throws(() => parseGoogleAntigravity({ groups: [] }, { models: {} }));
  assert.throws(() => parseGoogleAntigravity(null, null));
  assert.throws(() => parseGoogleAntigravity({ groups: [{ buckets: [{ remainingFraction: -1 }] }] }, {}));
  assert.throws(() => parseGoogleAntigravity({ groups: [{ buckets: [{ remainingFraction: 1.5 }] }] }, {}));
});
test('proxy controller verifies supported providers and rejects arbitrary actions', async () => {
  assert.equal(isProxySupported('google-pro-local'), true);
  assert.equal(isProxySupported('workbuddy-local'), true);
  assert.equal(isProxySupported('deepseek'), false);
  assert.equal(isProxySupported('unknown'), false);
  await assert.rejects(() => executeProxyControl('google-pro-local', 'restart'), /操作类型无效/);
  await assert.rejects(() => executeProxyControl('deepseek', 'start'), /不是受支持的本地反代/);
});
test('WorkBuddy 反代指向不依赖客户端的 v3 管理脚本', async () => {
  const src = await readFile(new URL('../miniapp/node/proxy-controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /manage_v3\.ps1/);
  assert.doesNotMatch(src, /manage_v2\.ps1/);
});
