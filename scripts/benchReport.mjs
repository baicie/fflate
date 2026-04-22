import * as fs from "node:fs";
import * as path from "node:path";

const input = fs.readFileSync(process.argv[2] ?? "/dev/stdin", "utf-8");
const lines = input.split("\n");

const SUITE_HEADER = /^ ✓ src\/benchmark\.bench\.ts > (\w+) +(\d+)ms$/;
// Dataset group stops at @ to avoid matching past "@ level" separator
const DATA_ROW =
  /^\s+·\s+(gzip-sync|pako\.gzip)\s+([^@\s][^@]*?)\s+@\s+level\s+(\S+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+±([\d.]+)%\s+(\d+)$/;

const seen = new Set();
const results = [];
let currentSuite = "";

function parseNum(s) {
  return parseFloat(s.replace(/,/g, ""));
}

for (const line of lines) {
  const suiteMatch = line.match(SUITE_HEADER);
  if (suiteMatch) {
    currentSuite = suiteMatch[1];
    continue;
  }
  const m = line.match(DATA_ROW);
  if (m && currentSuite) {
    const rawName = m[1] + " " + m[2];
    const key = `${currentSuite}:${rawName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = m[1];
    const libMap = { "gzip-sync": "gzip-sync", "pako.gzip": "pako" };
    const opMap = { "gzip-sync": "gzip", "pako.gzip": "gzip" };
    results.push({
      name: rawName.trim(),
      suite: currentSuite,
      hz: parseNum(m[4]),
      min: parseNum(m[5]),
      max: parseNum(m[6]),
      mean: parseNum(m[7]),
      p75: parseNum(m[8]),
      p99: parseNum(m[9]),
      p995: parseNum(m[10]),
      p999: parseNum(m[11]),
      rme: parseFloat(m[12]),
      samples: parseInt(m[13], 10),
      library: libMap[name],
      operation: opMap[name],
      dataset: m[2].trim(),
      level: m[3],
    });
  }
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
  const levelOrder = ["0", "6", "9"];

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
        const aL = levelOrder.indexOf(a.level);
        const bL = levelOrder.indexOf(b.level);
        if (aL !== bL) return aL - bL;
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
