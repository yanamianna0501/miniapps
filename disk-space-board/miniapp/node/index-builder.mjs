/**
 * 快照聚合：一次流式遍历同时产出
 *   - 各档位条目的实测体积 / 文件数 / 该条目下最大的若干文件
 *   - 未归类空间按目录分组的排行
 *   - 全盘目录树（用于任意层级下钻）
 *   - 扩展名分布与全局大文件榜
 *
 * 594,050 行 / 85MB 的清单实测约 5～10 秒完成，结果常驻内存，因此各项查询都是即时的。
 */

import { stat } from 'node:fs/promises';
import { readSnapshot } from './csv.mjs';
import { BUCKETS, TIERS, USER_HOME_PREFIX_LOWER } from './rules.mjs';

const GLOBAL_TOP = 600;
const BUCKET_TOP = 10;
const DIR_TOP = 8;
const MAX_TREE_DEPTH = 32;
const UNMATCHED_KEEP = 40;

function createNode(name) {
  return {
    n: name,
    s: 0, // 递归体积（MB）
    f: 0, // 递归文件数
    ds: 0, // 直属文件体积（MB）
    dfs: 0, // 直属文件数
    c: null, // 子目录 Map
    top: null, // 直属文件体积前 N 名 [name, sizeMB]
    t: 0, // 是否因深度上限被截断
  };
}

/** 按体积降序插入并封顶，插入位置用二分查找。 */
function insertSorted(arr, item, cap, sizeIdx) {
  const last = arr[arr.length - 1];
  if (arr.length >= cap && item[sizeIdx] <= last[sizeIdx]) return;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][sizeIdx] >= item[sizeIdx]) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
  if (arr.length > cap) arr.length = cap;
}

/** 未归类空间的目录分组键：用户目录下取 5 段，其余取 4 段。 */
function unmatchedKey(path, lower) {
  const parts = path.split('\\');
  const depth = lower.startsWith(USER_HOME_PREFIX_LOWER) ? 5 : 4;
  if (parts.length <= depth) return parts.slice(0, Math.max(parts.length - 1, 1)).join('\\');
  return parts.slice(0, depth).join('\\');
}

function insertFile(root, path, sizeMB, counters) {
  root.s += sizeMB;
  root.f += 1;
  const parts = path.split('\\');
  const fileName = parts.length > 1 ? parts.pop() : path;
  let node = root;
  const limit = Math.min(parts.length, MAX_TREE_DEPTH);
  for (let i = 0; i < limit; i += 1) {
    const name = parts[i];
    let child = node.c ? node.c.get(name) : undefined;
    if (!child) {
      child = createNode(name);
      if (!node.c) node.c = new Map();
      node.c.set(name, child);
      counters.dirs += 1;
    }
    node = child;
    node.s += sizeMB;
    node.f += 1;
  }
  if (parts.length > limit) node.t = 1;
  node.ds += sizeMB;
  node.dfs += 1;
  if (!node.top) node.top = [];
  insertSorted(node.top, [fileName, sizeMB], DIR_TOP, 1);
}

/**
 * 构建快照索引。
 * @param {string} csvPath
 * @param {{ signal?: AbortSignal, onProgress?: (p: {rows: number}) => void }} [options]
 */
export async function buildIndex(csvPath, options = {}) {
  const { signal, onProgress } = options;
  const startedAt = Date.now();
  const info = await stat(csvPath);

  const root = createNode('');
  const buckets = new Map();
  const extensions = new Map();
  const globalTop = [];
  const unmatchedDirs = new Map();
  const counters = { dirs: 0 };

  let totalMB = 0;
  let matchedMB = 0;
  let matchedFiles = 0;

  const rules = BUCKETS.map((bucket) => ({
    id: bucket.id,
    type: bucket.match ? bucket.match.type : null,
    value: bucket.match ? bucket.match.value : null,
  }));

  const row = await readSnapshot(
    csvPath,
    (path, ext, sizeMB, mtime) => {
      totalMB += sizeMB;
      const lower = path.toLowerCase();

      let matched = false;
      for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i];
        if (rule.type === null) continue;
        const hit =
          rule.type === 'prefix'
            ? lower.startsWith(rule.value)
            : rule.type === 'contains'
              ? lower.includes(rule.value)
              : lower === rule.value;
        if (!hit) continue;
        matched = true;
        let agg = buckets.get(rule.id);
        if (!agg) {
          agg = { sizeMB: 0, files: 0, top: [] };
          buckets.set(rule.id, agg);
        }
        agg.sizeMB += sizeMB;
        agg.files += 1;
        insertSorted(agg.top, [path, ext, sizeMB, mtime], BUCKET_TOP, 2);
      }

      if (matched) {
        matchedMB += sizeMB;
        matchedFiles += 1;
      } else {
        const key = unmatchedKey(path, lower);
        let agg = unmatchedDirs.get(key);
        if (!agg) {
          agg = [0, 0];
          unmatchedDirs.set(key, agg);
        }
        agg[0] += sizeMB;
        agg[1] += 1;
      }

      let extAgg = extensions.get(ext);
      if (!extAgg) {
        extAgg = [0, 0];
        extensions.set(ext, extAgg);
      }
      extAgg[0] += sizeMB;
      extAgg[1] += 1;

      insertSorted(globalTop, [path, ext, sizeMB, mtime], GLOBAL_TOP, 2);
      insertFile(root, path, sizeMB, counters);
    },
    { signal, onProgress },
  );

  const unmatchedList = [...unmatchedDirs.entries()]
    .map(([dir, agg]) => [dir, agg[0], agg[1]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, UNMATCHED_KEEP);

  const extList = [...extensions.entries()]
    .map(([ext, agg]) => [ext, agg[0], agg[1]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  return {
    source: {
      path: csvPath,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
      rows: row.rows,
      malformed: row.malformed,
      dirs: counters.dirs,
      elapsedMs: Date.now() - startedAt,
      builtAt: Date.now(),
    },
    totals: { sizeMB: totalMB, files: row.rows },
    matched: { sizeMB: matchedMB, files: matchedFiles },
    buckets,
    unclassified: { sizeMB: totalMB - matchedMB, files: row.rows - matchedFiles, dirs: unmatchedList },
    tree: root,
    extensions: extList,
    topFiles: globalTop.slice(0, 120),
  };
}

/** 按目录路径在树中定位节点。 */
export function walkTree(root, dirPath) {
  const cleaned = String(dirPath || '').replace(/\\+$/, '');
  const parts = cleaned.split('\\').filter((part) => part.length > 0);
  let node = root;
  for (const part of parts) {
    if (!node.c) return null;
    let next = node.c.get(part);
    if (!next) {
      const wanted = part.toLowerCase();
      for (const [key, value] of node.c) {
        if (key.toLowerCase() === wanted) {
          next = value;
          break;
        }
      }
    }
    if (!next) return null;
    node = next;
  }
  return node;
}

const mbToGB = (mb) => Math.round((mb / 1024) * 10000) / 10000;

/** 组装前端需要的档位 / 条目视图。实测值一律来自快照，方案值单独标注。 */
export function buildSummary(index) {
  const measuredOf = (bucket) => index.buckets.get(bucket.id) ?? null;

  const bucketRow = (bucket) => {
    const measured = measuredOf(bucket);
    const sizeGB = measured ? mbToGB(measured.sizeMB) : 0;
    return {
      id: bucket.id,
      name: bucket.name,
      action: bucket.action,
      tiers: bucket.tiers,
      path: bucket.path ?? null,
      status: bucket.status,
      note: bucket.note,
      planGB: bucket.planGB,
      planFiles: bucket.planFiles,
      sizeGB,
      files: measured ? measured.files : 0,
      diffGB: bucket.status === 'unresolved' ? null : Math.round((sizeGB - bucket.planGB) * 100) / 100,
      top: measured
        ? measured.top.map(([path, ext, sizeMB, mtime]) => ({ path, ext, sizeMB, mtime }))
        : [],
    };
  };

  const tiers = TIERS.map((tier) => {
    const rows = BUCKETS.filter((bucket) => bucket.tiers.includes(tier.id)).map(bucketRow);
    return {
      id: tier.id,
      label: tier.label,
      planTotalGB: tier.planTotalGB,
      planRowSumGB: Math.round(rows.reduce((sum, row) => sum + row.planGB, 0) * 100) / 100,
      measuredGB: Math.round(rows.reduce((sum, row) => sum + row.sizeGB, 0) * 100) / 100,
      risk: tier.risk,
      action: tier.action,
      reclaimable: tier.reclaimable,
      note: tier.note,
      rows,
    };
  });

  return {
    tiers,
    unclassified: {
      sizeGB: mbToGB(index.unclassified.sizeMB),
      files: index.unclassified.files,
      dirs: index.unclassified.dirs.map(([dir, sizeMB, files]) => ({
        dir,
        sizeGB: mbToGB(sizeMB),
        files,
      })),
    },
    extensions: index.extensions.map(([ext, sizeMB, files]) => ({
      ext: ext || '(无扩展名)',
      sizeGB: mbToGB(sizeMB),
      files,
    })),
    topFiles: index.topFiles.map(([path, ext, sizeMB, mtime]) => ({ path, ext, sizeMB, mtime })),
  };
}
