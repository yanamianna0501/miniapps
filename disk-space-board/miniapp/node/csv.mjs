/**
 * 扫描清单的流式读取。
 *
 * 清单格式固定为 路径,扩展名,大小MB,修改时间，由 Python 的 csv 模块写出：
 * UTF-8 带 BOM、CRLF 换行、只有含逗号的字段才加引号（实测 594,051 行中 450 行含引号）。
 * Windows 文件名不允许出现换行与双引号，所以一个字段不会跨行，按行解析是安全的。
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** 解析单行 CSV。只有出现引号时才走引号分支，避免全量字符扫描。 */
export function parseCsvLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 遍历清单，对每一行调用 onRecord(path, ext, sizeMB, mtime)。
 * 返回 { rows, malformed }；malformed 表示字段数不足、无法解释的行。
 */
export async function readSnapshot(csvPath, onRecord, options = {}) {
  const { onProgress, signal, progressEvery = 25000 } = options;
  const stream = createReadStream(csvPath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let rows = 0;
  let malformed = 0;
  let firstLine = true;
  let headerSkipped = false;

  try {
    for await (const rawLine of rl) {
      if (signal?.aborted) break;
      let line = rawLine;
      if (firstLine) {
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        firstLine = false;
      }
      if (line.length === 0) continue;
      const fields = parseCsvLine(line);
      if (!headerSkipped) {
        headerSkipped = true;
        if (fields[0] === '路径') continue;
      }
      if (fields.length < 4) {
        malformed += 1;
        continue;
      }
      rows += 1;
      const sizeMB = Number.parseFloat(fields[2]);
      onRecord(fields[0], fields[1], Number.isFinite(sizeMB) ? sizeMB : 0, fields[3]);
      if (onProgress && rows % progressEvery === 0) onProgress(rows);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { rows, malformed };
}

/** 写 CSV 文本时使用的转义，与 Python csv 的 QUOTE_MINIMAL 行为一致。 */
export function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return '"' + text.replaceAll('"', '""') + '"';
  return text;
}
