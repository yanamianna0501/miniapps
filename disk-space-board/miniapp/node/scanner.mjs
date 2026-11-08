/**
 * 全盘重新扫描。只读元数据（文件名、大小、修改时间），不打开任何文件内容，不修改任何文件。
 * 与 2026-10-03 那次扫描口径保持一致：跳过目录联接 / 符号链接以避免重复计数与循环，
 * 无权限目录计入 skipped 并在结果里列出来，不当作空数据。
 *
 * 实测吞吐约 0.1ms/文件：本机 59 万个文件约需 60～90 秒。
 */

import { createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { csvEscape } from './csv.mjs';

const MAX_DEPTH = 48;
const HARD_FILE_CAP = 5_000_000;
const CHUNK = 500;
const ROW_FLUSH = 4000;
const SKIPPED_KEEP = 80;

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        task().then(
          (value) => {
            resolve(value);
            release();
          },
          (error) => {
            reject(error);
            release();
          },
        );
      };
      if (active < max) run();
      else queue.push(run);
    });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function extensionOf(fullPath) {
  const dot = fullPath.lastIndexOf('.');
  if (dot === -1) return '';
  const slash = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
  return dot > slash ? fullPath.slice(dot).toLowerCase() : '';
}

/**
 * @param {{ root: string, outFile: string, signal?: AbortSignal,
 *   onProgress?: (p: object) => void, statConcurrency?: number, dirWorkers?: number }} options
 */
export async function scanRoot(options) {
  const { root, outFile, signal, onProgress } = options;
  const statLimit = createLimiter(options.statConcurrency ?? 48);
  const dirWorkers = Math.max(1, options.dirWorkers ?? 4);

  const queue = [root];
  const startedAt = Date.now();
  const stats = {
    dirs: 0,
    files: 0,
    bytes: 0,
    skippedLinks: 0,
    errors: 0,
    truncated: false,
    aborted: false,
  };
  const skipped = [];

  const stream = createWriteStream(outFile, { encoding: 'utf8' });
  let rows = [`\ufeff路径,扩展名,大小MB,修改时间`];

  const flush = async () => {
    if (rows.length === 0) return;
    const text = rows.join('\r\n') + '\r\n';
    rows = [];
    if (!stream.write(text)) await once(stream, 'drain');
  };

  const report = () => {
    if (!onProgress) return;
    onProgress({
      dirs: stats.dirs,
      files: stats.files,
      bytes: stats.bytes,
      skippedLinks: stats.skippedLinks,
      errors: stats.errors,
      elapsedMs: Date.now() - startedAt,
    });
  };

  let pendingRows = 0;
  const pushRow = (fullPath, stat) => {
    const sizeMB = Math.round((stat.size / 1048576) * 1000) / 1000;
    stats.files += 1;
    stats.bytes += stat.size;
    rows.push(`${csvEscape(fullPath)},${csvEscape(extensionOf(fullPath))},${sizeMB},${formatTime(stat.mtime)}`);
    pendingRows += 1;
  };

  let pending = 0;
  const processDir = async (dir, depth) => {
    let entries;
    try {
      const lst = await fs.lstat(dir);
      if (lst.isSymbolicLink()) {
        stats.skippedLinks += 1;
        return;
      }
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      stats.errors += 1;
      if (skipped.length < SKIPPED_KEEP) skipped.push({ dir, code: error.code ?? 'UNKNOWN' });
      return;
    }

    stats.dirs += 1;
    if (stats.dirs % 300 === 0) report();

    for (let offset = 0; offset < entries.length; offset += CHUNK) {
      const tasks = [];
      for (const entry of entries.slice(offset, offset + CHUNK)) {
        if (signal?.aborted) return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          stats.skippedLinks += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) queue.push(full);
          else stats.truncated = true;
          continue;
        }
        if (!entry.isFile()) continue;
        tasks.push(
          statLimit(async () => {
            try {
              const st = await fs.stat(full);
              if (!st.isFile()) return;
              pushRow(full, st);
            } catch {
              stats.errors += 1;
            }
          }),
        );
      }
      if (tasks.length > 0) await Promise.all(tasks);
      if (pendingRows >= ROW_FLUSH) {
        pendingRows = 0;
        await flush();
        report();
      }
      if (stats.files > HARD_FILE_CAP) {
        stats.truncated = true;
        return;
      }
    }
  };

  const runWorker = async () => {
    for (;;) {
      if (signal?.aborted) {
        stats.aborted = true;
        return;
      }
      const dir = queue.pop();
      if (dir === undefined) {
        if (pending === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      pending += 1;
      try {
        const depth = dir.split('\\').length;
        await processDir(dir, depth);
      } finally {
        pending -= 1;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: dirWorkers }, () => runWorker()));
    await flush();
  } finally {
    stream.end();
    await waitForFinish(stream);
  }

  stats.elapsedMs = Date.now() - startedAt;
  return { stats, skipped };
}

function waitForFinish(stream) {
  if (stream.writableFinished) return Promise.resolve();
  return once(stream, 'finish').then(
    () => undefined,
    () => undefined,
  );
}
