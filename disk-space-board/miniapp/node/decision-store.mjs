/**
 * 决策存储。所有变更都经过这里：校验 → 原子落盘 → 之后才广播。
 * 不执行任何文件操作：这里只记录「打算怎么处理」，不删除、不移动任何东西。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ACTIONS = ['clean', 'migrate', 'keep', 'later'];
const ACTION_SET = new Set(ACTIONS);
const KIND_SET = new Set(['bucket', 'dir', 'file']);
const MAX_NOTE = 600;
const MAX_LABEL = 400;
const MAX_ITEMS = 20000;

const ACTION_LABEL = {
  clean: '清理',
  migrate: '迁移',
  keep: '保留不动',
  later: '待定',
};

function depthOf(pathLower) {
  let count = 0;
  for (let i = 0; i < pathLower.length; i += 1) if (pathLower[i] === '\\') count += 1;
  return count;
}

function trimTrailing(pathLower) {
  return pathLower.replace(/\\+$/, '');
}

/** child 是否严格位于 parent 之内。 */
function isInside(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const parent = trimTrailing(parentPath);
  if (childPath === parent) return false;
  return childPath.startsWith(parent + '\\');
}

export class DecisionStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = join(dataDir, 'decisions.json');
    this.state = { version: 1, updatedAt: null, items: {} };
    this.loadError = null;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
        this.state = { version: 1, updatedAt: parsed.updatedAt ?? null, items: parsed.items };
      }
      this.loadError = null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.loadError = error.message;
        this.state = { version: 1, updatedAt: null, items: {} };
      }
    }
    return this.state;
  }

  static keyFor(kind, target) {
    return kind === 'bucket' ? `bucket:${target}` : `${kind}:${String(target).toLowerCase()}`;
  }

  /** 校验单条记录。非法输入抛出带说明的错误，不做静默兜底。 */
  normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('决策记录格式不正确');
    const kind = String(raw.kind ?? '');
    if (!KIND_SET.has(kind)) throw new Error(`未知的决策层级：${kind}`);
    const target = String(raw.target ?? '').trim();
    if (!target) throw new Error('决策目标为空');
    if (target.length > 500) throw new Error('决策目标过长');
    const action = String(raw.action ?? '');
    if (!ACTION_SET.has(action)) throw new Error(`未知的处置动作：${action}`);
    const sizeGB = Number(raw.sizeGB);
    if (!Number.isFinite(sizeGB) || sizeGB < 0) throw new Error('体积必须是大于等于 0 的数值');
    const files = Number.isFinite(Number(raw.files)) ? Math.max(0, Math.trunc(Number(raw.files))) : 0;
    const label = String(raw.label ?? target).slice(0, MAX_LABEL);
    const tier = raw.tier ? String(raw.tier).slice(0, 8) : null;
    const note = raw.note ? String(raw.note).slice(0, MAX_NOTE) : '';
    const path = raw.path ? String(raw.path).slice(0, 500) : null;
    return {
      key: DecisionStore.keyFor(kind, target),
      kind,
      target: kind === 'bucket' ? target : path ?? target,
      path,
      pathLower: path ? trimTrailing(path.toLowerCase()) : null,
      label,
      tier,
      action,
      sizeGB: Math.round(sizeGB * 10000) / 10000,
      files,
      note,
      updatedAt: Date.now(),
    };
  }

  /** 单条写入。commit 之后才返回，调用方随后才广播。 */
  async upsert(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error('没有要保存的决策');
    }
    if (rawList.length > 500) throw new Error('单次最多保存 500 条决策');

    const next = { ...this.state.items };
    const saved = [];
    for (const raw of rawList) {
      const record = this.normalize(raw);
      next[record.key] = record;
      saved.push(record);
    }
    if (Object.keys(next).length > MAX_ITEMS) throw new Error('决策条数超出上限');

    await this.#commit({ version: 1, updatedAt: Date.now(), items: next });
    return saved;
  }

  /** 撤销单条决策。 */
  async remove(kind, target) {
    const key = DecisionStore.keyFor(kind, target);
    if (!this.state.items[key]) return null;
    const next = { ...this.state.items };
    delete next[key];
    await this.#commit({ version: 1, updatedAt: Date.now(), items: next });
    return key;
  }

  async clear() {
    await this.#commit({ version: 1, updatedAt: Date.now(), items: {} });
  }

  /** 快照更新后，按桶 id 刷新其体积；目录/文件级决策保留标记当时的实测值。 */
  async refreshBucketSizes(sizeById) {
    let changed = false;
    const next = { ...this.state.items };
    for (const [key, item] of Object.entries(next)) {
      if (item.kind !== 'bucket') continue;
      const measured = sizeById[item.target];
      if (!measured) continue;
      if (measured.sizeGB !== item.sizeGB || measured.files !== item.files) {
        next[key] = { ...item, sizeGB: measured.sizeGB, files: measured.files };
        changed = true;
      }
    }
    if (changed) await this.#commit({ version: 1, updatedAt: Date.now(), items: next });
    return changed;
  }

  async #commit(nextState) {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(nextState, null, 2), 'utf8');
    await rename(tmp, this.file);
    this.state = nextState;
  }

  list() {
    return Object.values(this.state.items).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * 汇总。重叠按目录包含关系自动扣除：
   *   - 同一动作下，位于另一个已计入条目之内的条目不再重复累加；
   *   - 父条目已计入时，其内部被单独标为「保留」或另一种动作的子条目会从父条目中扣掉。
   */
  summary() {
    const items = this.list();
    const names = ACTION_LABEL;

    const netFor = (action) => {
      const primary = items.filter((item) => item.action === action && item.pathLower);
      const subtract = new Set(ACTIONS.filter((other) => other !== action));
      const roots = [];
      let total = 0;
      primary.sort((a, b) => depthOf(a.pathLower) - depthOf(b.pathLower));

      for (const item of primary) {
        if (roots.some((root) => isInside(item.pathLower, root.pathLower))) continue;
        roots.push(item);
        let size = item.sizeGB;
        for (const other of items) {
          if (!other.pathLower) continue;
          if (subtract.has(other.action) && isInside(other.pathLower, item.pathLower)) {
            size -= other.sizeGB;
          }
        }
        total += Math.max(0, size);
      }

      const pathless = items
        .filter((item) => item.action === action && !item.pathLower)
        .reduce((sum, item) => sum + item.sizeGB, 0);

      return Math.round((total + pathless) * 10000) / 10000;
    };

    const counts = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
    for (const item of items) counts[item.action] += 1;

    return {
      updatedAt: this.state.updatedAt,
      total: items.length,
      counts,
      cleanGB: netFor('clean'),
      migrateGB: netFor('migrate'),
      keepGB: Math.round(items.filter((i) => i.action === 'keep').reduce((s, i) => s + i.sizeGB, 0) * 10000) / 10000,
      laterGB: Math.round(items.filter((i) => i.action === 'later').reduce((s, i) => s + i.sizeGB, 0) * 10000) / 10000,
      loadError: this.loadError,
      actionLabels: names,
    };
  }

  /** 导出决策清单（CSV 文本，带 BOM）。 */
  toCsv(csvEscape) {
    const rows = [['层级', '目标', '所属档位', '处置动作', '体积_GB', '文件数', '备注', '更新时间']];
    for (const item of this.list()) {
      rows.push([
        item.kind === 'bucket' ? '条目' : item.kind === 'dir' ? '目录' : '文件',
        item.path ?? item.target,
        item.tier ?? '',
        ACTION_LABEL[item.action] ?? item.action,
        item.sizeGB,
        item.files,
        item.note,
        new Date(item.updatedAt).toISOString(),
      ]);
    }
    return '\ufeff' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  }
}
