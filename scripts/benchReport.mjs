import * as fs from "node:fs";
import * as path from "node:path";

const input = fs.readFileSync(process.argv[2] ?? "/dev/stdin", "utf-8");
const lines = input.split("\n");

const results = [];
const seen = new Set();
let currentSuite = "";

const KNOWN_LIBS = ["gzip-sync", "pako.gzip"];
const LIB_MAP = { "gzip-sync": "gzip-sync", "pako.gzip": "pako" };
const OP_MAP = { "gzip-sync": "gzip", "pako.gzip": "gzip" };

function parseNum(s) {
  return parseFloat(s.replace(/,/g, ""));
}

/**
 * Parse a benchmark data row.
 *
 * Layout:
 *   [prefix] <lib>  <dataset> @ level <lvl>  <hz> <min> <max> <mean> <p75> <p99> <p995> <p999>  ±<rme>% <samples>
 *
 * Approach:
 *   - Normalize middle dot to space, collapse whitespace.
 *   - Extract rme and samples from the right (after ±).
 *   - Find the lib name to locate the start of the dataset.
 *   - Extract level (the number right before the numeric sequence).
 *   - Extract 8 numeric columns from right-to-left counting.
 */
function parseRow(rawLine) {
  // Strip middle dot (·) and normalize whitespace
  const clean = rawLine.replace(/\u00B7/g, " ").replace(/\s+/g, " ").trim();

  // Must contain known lib marker and ±
  const hasLib = KNOWN_LIBS.some((lib) => clean.includes(lib));
  if (!hasLib || !clean.includes("±")) return null;

  // ── Extract rme and samples from the right ────────────────────────────────
  const rmeMatch = clean.match(/±([\d.]+)%/);
  const samplesMatch = clean.match(/%\s+(\d+)\s*$/);
  if (!rmeMatch || !samplesMatch) return null;
  const rme = parseFloat(rmeMatch[1]);
  const samples = parseInt(samplesMatch[1], 10);

  // ── Extract 8 numeric columns from right ─────────────────────────────────
  // Tokenize the part before ±
  const beforeRme = clean.slice(0, clean.indexOf("±"));

  // Split by whitespace and collect tokens
  const tokens = beforeRme.split(" ").filter(Boolean);

  // Scan backward from the end to collect the 8 numeric columns
  let numTokens = [];
  let tokIdx = tokens.length - 1;
  while (tokIdx >= 0 && numTokens.length < 8) {
    const t = tokens[tokIdx];
    if (/^\d/.test(t)) {
      numTokens.unshift(t);
    } else {
      break;
    }
    tokIdx--;
  }

  if (numTokens.length !== 8) return null;

  // ── Extract level (the number right before the numeric sequence) ────────────
  const level = tokens[tokIdx]; // tokIdx now points to the level number
  if (!level || isNaN(parseInt(level, 10))) return null;

  // ── Extract lib and dataset ───────────────────────────────────────────────
  const libName = KNOWN_LIBS.find((lib) => tokens.includes(lib));
  if (!libName) return null;

  const libPos = tokens.indexOf(libName);
  // Find "@ level" in tokens and stop there — dataset is between lib and "@"
  const atLevelPos = tokens.indexOf("@", libPos);
  if (atLevelPos === -1 || atLevelPos >= tokIdx) return null;
  // Dataset = tokens between lib and "@"
  const dataset = tokens.slice(libPos + 1, atLevelPos).join(" ");

  const [hzStr, minStr, maxStr, meanStr, p75Str, p99Str, p995Str, p999Str] = numTokens;

  const hz = parseNum(hzStr);
  const min = parseNum(minStr);
  const max = parseNum(maxStr);
  const mean = parseNum(meanStr);
  const p75 = parseNum(p75Str);
  const p99 = parseNum(p99Str);
  const p995 = parseNum(p995Str);
  const p999 = parseNum(p999Str);

  if ([hz, min, max, mean, p75, p99, p995, p999].some(isNaN)) return null;

  return {
    name: `${libName}  ${dataset} @ level ${level}`,
    library: LIB_MAP[libName],
    operation: OP_MAP[libName],
    dataset,
    level,
    hz,
    min,
    max,
    mean,
    p75,
    p99,
    p995,
    p999,
    rme,
    samples,
  };
}

for (const line of lines) {
  const trimmed = line.trimStart();

  // Suite header: "✓ src/benchmark.bench.ts > <name> <ms>ms"
  if (trimmed.startsWith("✓") && trimmed.includes("src/benchmark.bench.ts")) {
    const m = trimmed.match(/^✓[^>]*>\s+(\w+)\s+\d+ms/);
    if (m) currentSuite = m[1];
    continue;
  }

  const parsed = parseRow(trimmed);
  if (!parsed) continue;

  const key = `${currentSuite}:${parsed.name}`;
  if (seen.has(key)) continue;
  seen.add(key);

  results.push({
    ...parsed,
    suite: currentSuite,
  });
}

const suites = [...new Set(results.map((r) => r.suite))];

const fasterCount = {};
const slowerCount = {};

const byDataset = new Map();
for (const r of results) {
  const key = `${r.suite}:${r.dataset}:${r.level}`;
  if (!byDataset.has(key)) byDataset.set(key, []);
  byDataset.get(key).push(r);
}

for (const [, rows] of byDataset) {
  if (rows.length < 2) continue;
  const gzipRow = rows.find((r) => r.library === "gzip-sync");
  const pakoRow = rows.find((r) => r.library === "pako");
  if (!gzipRow || !pakoRow) continue;
  const suite = gzipRow.suite;
  if (gzipRow.hz > pakoRow.hz) {
    fasterCount[suite] = (fasterCount[suite] ?? 0) + 1;
  } else {
    slowerCount[suite] = (slowerCount[suite] ?? 0) + 1;
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  sha: process.env.GITHUB_SHA ?? "",
  trigger: process.env.GITHUB_TRIGGER ?? "local",
  suites,
  results,
  summary: {
    totalSuites: suites.length,
    totalBenchmarks: results.length,
    fasterCount,
    slowerCount,
  },
};

const outputDir = path.join(process.env.RUNNER_TEMP ?? ".", "bench-results");
fs.mkdirSync(outputDir, { recursive: true });

fs.writeFileSync(
  path.join(outputDir, "benchmark-report.json"),
  JSON.stringify(report, null, 2)
);

function generateMarkdown(report) {
  const lines = [];
  lines.push("# fflate Benchmark Report");
  lines.push("");
  lines.push(`| **Generated** | ${report.generatedAt} |`);
  lines.push(`|---|---|
| **SHA** | \`${report.sha}\` |
| **Trigger** | ${report.trigger} |`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Suites: ${report.summary.totalSuites}`);
  lines.push(`- Total benchmarks: ${report.summary.totalBenchmarks}`);
  lines.push("");
  lines.push("| Suite | gzip-sync faster | pako faster |");
  lines.push("|---|---|---|");
  for (const suite of report.suites) {
    const f = report.summary.fasterCount[suite] ?? 0;
    const p = report.summary.slowerCount[suite] ?? 0;
    lines.push(`| ${suite} | ${f} | ${p} |`);
  }
  lines.push("");

  const sizeOrder = ["tiny", "small", "text", "medium", "large", "huge", "repetitive", "zeros", "mixed"];

  for (const suite of report.suites) {
    lines.push(`## ${suite}`);
    lines.push("");
    lines.push("| Dataset | Level | Library | hz | Mean (ms) | p75 (ms) | p99 (ms) | RME |");
    lines.push("|---|---|---|---|---|---|---|---|");

    const suiteRows = report.results
      .filter((r) => r.suite === suite)
      .sort((a, b) => {
        const aIdx = sizeOrder.findIndex((s) => a.dataset.includes(s));
        const bIdx = sizeOrder.findIndex((s) => b.dataset.includes(s));
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.library === "gzip-sync" ? -1 : 1;
      });

    for (const r of suiteRows) {
      lines.push(
        `| ${r.dataset} | ${r.level} | ${r.library} | ${r.hz.toLocaleString()} | ${r.mean.toFixed(4)} | ${r.p75.toFixed(4)} | ${r.p99.toFixed(4)} | ±${r.rme}% |`
      );
    }
    lines.push("");
  }

  lines.push("## Column Descriptions");
  lines.push("");
  lines.push("- **hz**: Operations per second (higher = faster)");
  lines.push("- **min / max**: Fastest and slowest single operation (ms)");
  lines.push("- **mean**: Arithmetic mean operation time (ms)");
  lines.push("- **p75 / p99 / p995 / p999**: Percentiles (ms)");
  lines.push("- **rme**: Relative margin of error (%)");
  lines.push("- **samples**: Number of measurements");
  lines.push("");
  lines.push("Full results: `benchmark-report.json`");

  return lines.join("\n");
}

const md = generateMarkdown(report);
fs.writeFileSync(path.join(outputDir, "benchmark-report.md"), md);

console.log(`Reports written to ${outputDir}/`);
console.log("  - benchmark-report.json");
console.log("  - benchmark-report.md");
