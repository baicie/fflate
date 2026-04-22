import { describe, bench } from "vitest";
import * as pako from "pako";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { gzipSync } = require("./gzip-sync.mjs");

// ─── Test data factories ───────────────────────────────────────────────────────

function randomBytes(len: number, seed?: number): Uint8Array {
  let state = seed ?? Date.now();
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    arr[i] = (state >>> 0) % 256;
  }
  return arr;
}

function repetitiveBytes(len: number, period = 10): Uint8Array {
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = i % period;
  return arr;
}

function zeroBytes(len: number): Uint8Array {
  return new Uint8Array(len);
}

function textBytes(): Uint8Array {
  const text = `The quick brown fox jumps over the lazy dog. ` +
    `Pack my box with five dozen liquor jugs. ` +
    `How vexingly quick daft zebras jump! ` +
    `The five boxing wizards jump quickly. `.repeat(50);
  return new TextEncoder().encode(text);
}

function mixedBytes(len: number, seed?: number): Uint8Array {
  let state = seed ?? 12345;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    const r = ((state >>> 0) % 1000) / 1000;
    if (r < 0.4) arr[i] = 0;
    else if (r < 0.7) arr[i] = i % 256;
    else arr[i] = ((state * 1664525) >>> 0) % 256;
  }
  return arr;
}

// ─── Data set ─────────────────────────────────────────────────────────────────

const DATASETS_SMALL: Record<string, Uint8Array> = {
  "tiny (100 B)": randomBytes(100, 1),
  "small (1 KB)": randomBytes(1024, 2),
  "text (3.5 KB)": textBytes(),
};

const DATASETS_LARGE: Record<string, Uint8Array> = {
  "medium (10 KB)": randomBytes(10 * 1024, 10),
  "large (100 KB)": randomBytes(100 * 1024, 11),
  "huge (1 MB)": randomBytes(1024 * 1024, 12),
  "repetitive (100 KB, period=10)": repetitiveBytes(100 * 1024, 10),
  "zeros (100 KB)": zeroBytes(100 * 1024),
  "mixed (100 KB)": mixedBytes(100 * 1024, 20),
};

const DATASETS = { ...DATASETS_SMALL, ...DATASETS_LARGE };

const LEVELS_SMALL = [0, 6, 9] as const;
const LEVELS_LARGE = [6, 9] as const;

// ─── gzip compression ──────────────────────────────────────────────────────────

describe("gzip", () => {
  for (const [name, data] of Object.entries(DATASETS_SMALL)) {
    for (const level of LEVELS_SMALL) {
      const label = `${name} @ level ${level}`;

      bench(`gzip-sync  ${label}`, () => {
        gzipSync(data, { level });
      });

      bench(`pako.gzip       ${label}`, () => {
        pako.gzip(data, { level });
      });
    }
  }

  for (const [name, data] of Object.entries(DATASETS_LARGE)) {
    for (const level of LEVELS_LARGE) {
      const label = `${name} @ level ${level}`;

      bench(`gzip-sync  ${label}`, () => {
        gzipSync(data, { level });
      });

      bench(`pako.gzip       ${label}`, () => {
        pako.gzip(data, { level });
      });
    }
  }
});

// ─── Output size comparison ───────────────────────────────────────────────────

describe("output size comparison", () => {
  bench("gzip output size (100 KB repetitive, level 9)", () => {
    const data = repetitiveBytes(100 * 1024, 10);
    const gzipSyncSize = gzipSync(data, { level: 9 }).length;
    const pakoSize = pako.gzip(data, { level: 9 }).length;
    if (gzipSyncSize === 0 || pakoSize === 0) throw new Error("Empty output");
  });
});
