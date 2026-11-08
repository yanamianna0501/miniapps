// @ts-check
/**
 * Durable sampling history for the quota windows.
 *
 * ChatGPT exposes current window usage, not a usage ledger, so trends are derived
 * from consecutive samples: when a window's used percentage rises inside the same
 * window (same reset timestamp) the difference is attributed to today. A changed
 * reset timestamp means the window rolled over, so no delta is counted for it.
 *
 * Everything is stored under the Host-provided dataDir as one small JSON document.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_NAME = 'quota-history.json';
const RETAIN_DAYS = 90;
const MAX_DAYS = RETAIN_DAYS + 5;

/** @typedef {{ t: number, usedPercent: number, resetAt: number | null }} WindowSample */
/** @typedef {{ primary: number, secondary: number, samples: number }} DayBucket */

/**
 * @param {string} dataDir
 */
export async function openStore(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, FILE_NAME);
  /** @type {{ version: number, lastSample: { t: number, primary: WindowSample | null, secondary: WindowSample | null } | null, days: Record<string, DayBucket>, totalSamples: number }} */
  let state = { version: 1, lastSample: null, days: {}, totalSamples: 0 };

  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.days && typeof parsed.days === 'object') {
      state = {
        version: 1,
        lastSample: parsed.lastSample ?? null,
        days: parsed.days,
        totalSamples: Number(parsed.totalSamples) || 0,
      };
    }
  } catch {
    // First run, or an unreadable file: start clean rather than fail the board.
  }

  let writeChain = Promise.resolve();

  /** @param {Record<string, DayBucket>} days */
  function prune(days) {
    const cutoff = dayKey(Date.now() - RETAIN_DAYS * 86400000);
    for (const key of Object.keys(days)) {
      if (key < cutoff) delete days[key];
    }
    const keys = Object.keys(days).sort();
    if (keys.length > MAX_DAYS) {
      for (const key of keys.slice(0, keys.length - MAX_DAYS)) delete days[key];
    }
  }

  function persist() {
    prune(state.days);
    const snapshot = JSON.stringify(state);
    writeChain = writeChain.then(async () => {
      const temp = `${file}.tmp`;
      await writeFile(temp, snapshot, 'utf8');
      await rename(temp, file);
    }).catch(() => undefined);
    return writeChain;
  }

  return {
    /**
     * Record one quota observation and return the resulting history view.
     * @param {{ primary: { usedPercent: number, resetAt: number | null } | null, secondary: { usedPercent: number, resetAt: number | null } | null }} quota
     */
    record(quota) {
      const now = Date.now();
      const today = dayKey(now);
      const bucket = state.days[today] ?? { primary: 0, secondary: 0, samples: 0 };
      const nextPrimary = quota.primary
        ? { t: now, usedPercent: quota.primary.usedPercent, resetAt: quota.primary.resetAt }
        : null;
      const nextSecondary = quota.secondary
        ? { t: now, usedPercent: quota.secondary.usedPercent, resetAt: quota.secondary.resetAt }
        : null;

      const previous = state.lastSample;
      if (previous) {
        const deltaPrimary = windowDelta(previous.primary, nextPrimary);
        const deltaSecondary = windowDelta(previous.secondary, nextSecondary);
        bucket.primary = round1(bucket.primary + deltaPrimary);
        bucket.secondary = round1(bucket.secondary + deltaSecondary);
      }

      bucket.samples += 1;
      state.days[today] = bucket;
      state.lastSample = { t: now, primary: nextPrimary, secondary: nextSecondary };
      state.totalSamples += 1;
      void persist();
      return this.snapshot();
    },

    snapshot() {
      const days = Object.keys(state.days).sort().map((date) => ({ date, ...state.days[date] }));
      return {
        days,
        totalSamples: state.totalSamples,
        lastSampleAt: state.lastSample?.t ?? null,
        retainedDays: RETAIN_DAYS,
      };
    },
  };
}

/**
 * @param {WindowSample | null} previous
 * @param {WindowSample | null} next
 */
function windowDelta(previous, next) {
  if (!previous || !next) return 0;
  if (previous.resetAt !== null && next.resetAt !== null && previous.resetAt !== next.resetAt) return 0;
  const delta = next.usedPercent - previous.usedPercent;
  return delta > 0 ? delta : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** @param {number} timestamp */
function dayKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
