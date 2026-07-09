#!/usr/bin/env node
/**
 * Custom HTML Report Generator for Playwright
 * Reads test-results.json and generates a custom-report.html
 */

const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "..", "./test-results/test-results.json");
const OUTPUT_FILE = path.join(__dirname, "..", "./reports/index.html");
const HISTORY_FILE = path.join(__dirname, "..", "./reports/test-history.json");

// Ensure the reports output directory exists
const REPORTS_DIR = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

if (!fs.existsSync(INPUT_FILE)) {
  console.error(
    `❌  test-results.json not found.\n   Run:  npm run test:json  first.`
  );
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));

/* ------------------------------------------------------------------ */
/*  Flatten every test result across all suites                        */
/* ------------------------------------------------------------------ */
function flattenTests(suites, parentTitle = "") {
  const results = [];
  for (const suite of suites || []) {
    const title = parentTitle
      ? `${parentTitle} > ${suite.title}`
      : suite.title;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const result = test.results?.[0] || {};
        results.push({
          suite: title,
          title: spec.title,
          fullTitle: `${title} > ${spec.title}`,
          status: test.status, // "expected" | "unexpected" | "skipped" | "flaky"
          outcome: result.status, // "passed" | "failed" | "timedOut" | "skipped"
          project: test.projectName || "",
          duration: result.duration || 0,
          file: spec.file || "",
          line: spec.line || 0,
          error: result.error?.message || result.errors?.[0]?.message || "",
          retries: (test.results?.length || 1) - 1,
        });
      }
    }
    if (suite.suites?.length) {
      results.push(...flattenTests(suite.suites, title));
    }
  }
  return results;
}

const tests = flattenTests(data.suites || []);

/* ------------------------------------------------------------------ */
/*  Stats                                                              */
/* ------------------------------------------------------------------ */
const total = tests.length;
const passed = tests.filter(
  (t) => t.outcome === "passed" || t.status === "expected"
).length;
const failed = tests.filter(
  (t) =>
    t.outcome === "failed" ||
    t.outcome === "timedOut" ||
    t.status === "unexpected"
).length;
const skipped = tests.filter(
  (t) => t.outcome === "skipped" || t.status === "skipped"
).length;
const flaky = tests.filter((t) => t.status === "flaky").length;

const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";
const runDate = new Date(data.stats?.startTime || Date.now()).toLocaleString();
const totalDurationMs = data.stats?.duration || 0;
const totalDurationSec = (totalDurationMs / 1000).toFixed(2);

/* ------------------------------------------------------------------ */
/*  History tracking                                                   */
/* ------------------------------------------------------------------ */
let history = [];
if (fs.existsSync(HISTORY_FILE)) {
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")); } catch {}
}
const newEntry = {
  date: new Date(data.stats?.startTime || Date.now()).toISOString(),
  label: runDate,
  total,
  passed,
  failed,
  skipped,
  flaky,
  passRate: parseFloat(passRate),
};
if (!history.some((h) => h.date === newEntry.date)) {
  history.push(newEntry);
}
if (history.length > 30) history = history.slice(-30);
fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function statusLabel(t) {
  if (t.status === "flaky") return "FLAKY";
  if (t.outcome === "passed") return "PASS";
  if (t.outcome === "failed" || t.outcome === "timedOut") return "FAIL";
  if (t.outcome === "skipped") return "SKIP";
  // fallback
  if (t.status === "expected") return "PASS";
  if (t.status === "unexpected") return "FAIL";
  return t.outcome?.toUpperCase() || "UNKNOWN";
}

function statusClass(t) {
  const lbl = statusLabel(t);
  if (lbl === "PASS") return "pass";
  if (lbl === "FAIL") return "fail";
  if (lbl === "FLAKY") return "flaky";
  return "skip";
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Extract the top-level folder name from a relative test file path.
// e.g. "google/login.spec.ts" → "google",  "example.spec.ts" → "example"
function getFeature(filePath) {
  if (!filePath) return "(unknown)";
  const parts = filePath.split("/");
  if (parts.length > 1) return parts[0];
  return parts[0].replace(/\.(spec|test)\.(ts|js|tsx|jsx)$/, "").replace(/\.(ts|js|tsx|jsx)$/, "") || "(root)";
}

/* ------------------------------------------------------------------ */
/*  Build rows HTML                                                    */
/* ------------------------------------------------------------------ */
const rows = tests
  .map((t, i) => {
    const cls = statusClass(t);
    const lbl = statusLabel(t);
    const errHtml = t.error
      ? `<div class="error-msg">${escapeHtml(t.error)}</div>`
      : "";
    const retryBadge =
      t.retries > 0
        ? `<span class="retry-badge">↺ ${t.retries}</span>`
        : "";

    return `
    <tr class="row-${cls}" data-status="${cls}">
      <td class="num">${i + 1}</td>
      <td class="test-title">
        <span class="project-tag">${escapeHtml(t.project)}</span>
        <span class="test-name">${escapeHtml(t.title)}</span>${retryBadge}
        ${errHtml}
      </td>
      <td class="suite-col">${escapeHtml(t.suite)}</td>
      <td class="file-col">${escapeHtml(t.file)}${t.line ? `:${t.line}` : ""}</td>
      <td><span class="badge badge-${cls}">${lbl}</span></td>
      <td class="dur-col">${fmtDuration(t.duration)}</td>
    </tr>`;
  })
  .join("\n");

/* ------------------------------------------------------------------ */
/*  Canvas placeholder — donut drawn client-side by JS               */
/* ------------------------------------------------------------------ */
const pieHtml = '<canvas id="canvasDonut" class="donut-chart" style="display:block"></canvas>';

/* ------------------------------------------------------------------ */
/*  Canvas placeholders — all charts drawn client-side by JS         */
/* ------------------------------------------------------------------ */
function buildPassRateChart(_hist) {
  return '<canvas id="canvasPassRate" style="width:100%;height:220px;display:block"></canvas>';
}

function buildTotalChart(_hist) {
  return '<canvas id="canvasTotal" style="width:100%;height:200px;display:block"></canvas>';
}

const passRateChartHtml = buildPassRateChart(history);
const totalChartHtml    = buildTotalChart(history);

/* ------------------------------------------------------------------ */
/*  Feature chart builder (SVG horizontal stacked bars)               */
/* ------------------------------------------------------------------ */
// Aggregate test results by feature folder
const featureMap = {};
for (const t of tests) {
  const feat = getFeature(t.file);
  if (!featureMap[feat]) featureMap[feat] = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  featureMap[feat].total++;
  const lbl = statusLabel(t);
  if (lbl === "PASS")       featureMap[feat].passed++;
  else if (lbl === "FAIL")  featureMap[feat].failed++;
  else if (lbl === "SKIP")  featureMap[feat].skipped++;
  else if (lbl === "FLAKY") featureMap[feat].flaky++;
}
const featureStats = Object.entries(featureMap)
  .map(([name, s]) => ({ name, ...s }))
  .sort((a, b) => b.total - a.total);

function buildFeatureChart(features) {
  const h = Math.max(features.length * 36 + 16, 60);
  return '<canvas id="canvasFeature" style="width:100%;height:' + h + 'px;display:block"></canvas>';
}

const featureChartHtml = buildFeatureChart(featureStats);

// Safely embed an object as JSON inside a <script> block
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

/* ------------------------------------------------------------------ */
/*  HTML template                                                      */
/* ------------------------------------------------------------------ */
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Playwright Custom Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           background: #f1f5f9; color: #1e293b; }

    /* ---- HEADER ---- */
    header { background: linear-gradient(135deg, #1e3a5f 0%, #0f766e 100%);
             color: #fff; padding: 24px 32px; }
    header h1 { font-size: 1.6rem; font-weight: 700; letter-spacing: -.5px; }
    header p  { font-size: .85rem; opacity: .8; margin-top: 4px; }

    /* ---- LAYOUT ---- */
    main { max-width: 1300px; margin: 24px auto; padding: 0 16px; }

    /* ---- SUMMARY CARDS ---- */
    .summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 16px 24px;
            flex: 1; min-width: 140px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    .card .num  { font-size: 2rem; font-weight: 700; line-height: 1; }
    .card .lbl  { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
                  color: #64748b; margin-top: 4px; }
    .card.total .num { color: #1e293b; }
    .card.pass  .num { color: #16a34a; }
    .card.fail  .num { color: #dc2626; }
    .card.skip  .num { color: #d97706; }
    .card.flaky .num { color: #9333ea; }

    /* ---- CHART + SUMMARY ROW ---- */
    .top-row { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start;
               margin-bottom: 24px; }
    .donut-wrap { background:#fff; border-radius:12px; padding:24px;
                  box-shadow:0 1px 4px rgba(0,0,0,.08); display:flex;
                  flex-direction:column; align-items:center; gap:12px; min-width:200px; }
    .donut-chart { width: 160px; height: 160px; }
    .legend { display:flex; flex-direction:column; gap:6px; font-size:.8rem; }
    .legend-item { display:flex; align-items:center; gap:8px; }
    .legend-dot  { width:12px; height:12px; border-radius:50%; flex-shrink:0; }

    /* ---- FILTERS ---- */
    .filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
    .filter-btn { padding:6px 16px; border-radius:20px; border:1.5px solid #cbd5e1;
                  background:#fff; font-size:.8rem; cursor:pointer; transition:all .15s; }
    .filter-btn:hover, .filter-btn.active { background:#0f766e; color:#fff;
                                            border-color:#0f766e; }

    /* ---- TABLE ---- */
    .table-wrap { background:#fff; border-radius:12px; overflow:hidden;
                  box-shadow:0 1px 4px rgba(0,0,0,.08); }
    table { width:100%; border-collapse:collapse; font-size:.85rem; }
    thead th { background:#0f172a; color:#e2e8f0; padding:12px 16px;
               text-align:left; font-weight:600; white-space:nowrap; }
    tbody tr { border-bottom:1px solid #f1f5f9; transition:background .1s; }
    tbody tr:hover { background:#f8fafc; }
    tbody td { padding:10px 16px; vertical-align:top; }

    td.num { color:#94a3b8; width:40px; text-align:right; }
    td.dur-col { white-space:nowrap; color:#64748b; }
    td.suite-col { color:#475569; font-size:.78rem; }
    td.file-col  { color:#475569; font-size:.78rem; white-space:nowrap; }

    .test-name { font-weight:500; }
    .project-tag { font-size:.7rem; background:#e0f2fe; color:#0369a1;
                   border-radius:4px; padding:1px 6px; margin-right:6px;
                   white-space:nowrap; }
    .retry-badge { font-size:.7rem; background:#fef3c7; color:#92400e;
                   border-radius:4px; padding:1px 6px; margin-left:6px; }
    .error-msg { font-size:.75rem; color:#dc2626; background:#fef2f2;
                 border-left:3px solid #fca5a5; padding:6px 8px;
                 margin-top:6px; border-radius:0 4px 4px 0;
                 font-family:monospace; white-space:pre-wrap; word-break:break-word; }

    /* ---- BADGES ---- */
    .badge { font-size:.7rem; font-weight:700; padding:3px 8px;
             border-radius:20px; white-space:nowrap; }
    .badge-pass  { background:#dcfce7; color:#15803d; }
    .badge-fail  { background:#fee2e2; color:#b91c1c; }
    .badge-skip  { background:#fef3c7; color:#b45309; }
    .badge-flaky { background:#f3e8ff; color:#7e22ce; }

    /* ---- ROW STATUS STRIPE ---- */
    .row-fail  { border-left:3px solid #ef4444; }
    .row-pass  { border-left:3px solid #22c55e; }
    .row-skip  { border-left:3px solid #f59e0b; }
    .row-flaky { border-left:3px solid #a855f7; }

    /* ---- HIDDEN ---- */
    .hidden { display: none !important; }

    /* ---- SEARCH ---- */
    .search-wrap { flex:1; min-width:200px; }
    .search-wrap input { width:100%; padding:7px 12px; border-radius:8px;
                         border:1.5px solid #cbd5e1; font-size:.85rem; outline:none; }
    .search-wrap input:focus { border-color:#0f766e; }

    footer { text-align:center; font-size:.75rem; color:#94a3b8;
             padding:24px; }

    /* ---- HISTORY CHARTS ---- */
    .history-section { margin-bottom: 24px; }
    .history-section h2 { font-size: 1rem; font-weight: 600; color: #1e293b;
                          margin-bottom: 14px; }
    .history-row { display: flex; gap: 20px; flex-wrap: wrap; }
    .history-card { background: #fff; border-radius: 12px; padding: 20px 20px 12px;
                    box-shadow: 0 1px 4px rgba(0,0,0,.08); flex: 1; min-width: 300px; }
    .chart-title { font-size: .85rem; font-weight: 600; color: #1e293b;
                   margin-bottom: 10px; }
    .chart-empty { font-size: .8rem; color: #94a3b8; text-align: center;
                   padding: 40px 0; }
    .chart-legend-row { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px;
                        font-size: .75rem; color: #475569; }
    .chart-legend-row span { display: flex; align-items: center; gap: 5px; }
    .chart-legend-row .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }

    /* ---- CHART TOOLTIP ---- */
    .chart-tooltip { position:fixed; background:#1e293b; color:#f8fafc; padding:10px 14px;
                     border-radius:9px; font-size:.78rem; line-height:1.7; pointer-events:none;
                     z-index:9999; box-shadow:0 6px 20px rgba(0,0,0,.28); white-space:nowrap;
                     display:none; border:1px solid rgba(255,255,255,.08); }
    .chart-tooltip .tt-label { font-size:.7rem; color:#94a3b8; margin-bottom:3px; }
    .chart-tooltip .tt-rate  { font-size:1.15rem; font-weight:700; line-height:1.2; }
    .chart-tooltip .tt-row   { display:flex; gap:14px; margin-top:5px; font-size:.78rem; }
    .chart-tooltip .tt-pass  { color:#4ade80; }
    .chart-tooltip .tt-fail  { color:#f87171; }
    .chart-tooltip .tt-total { color:#94a3b8; font-size:.72rem; margin-top:3px; }
  </style>
</head>
<body>

<header>
  <h1>&#9658; Playwright Test Report</h1>
  <p>Run date: ${escapeHtml(runDate)} &nbsp;|&nbsp; Duration: ${totalDurationSec}s</p>
</header>

<main>

  <!-- Summary cards -->
  <div class="summary">
    <div class="card total"><div class="num">${total}</div><div class="lbl">Total</div></div>
    <div class="card pass" ><div class="num">${passed}</div><div class="lbl">Passed</div></div>
    <div class="card fail" ><div class="num">${failed}</div><div class="lbl">Failed</div></div>
    <div class="card skip" ><div class="num">${skipped}</div><div class="lbl">Skipped</div></div>
    <div class="card flaky"><div class="num">${flaky}</div><div class="lbl">Flaky</div></div>
  </div>

  <!-- Chart + legend -->
  <div class="top-row">
    <div class="donut-wrap">
      ${pieHtml}
      <div class="legend">
        <div class="legend-item"><div class="legend-dot" style="background:#22c55e"></div>Passed (${passed})</div>
        <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>Failed (${failed})</div>
        <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>Skipped (${skipped})</div>
        <div class="legend-item"><div class="legend-dot" style="background:#a855f7"></div>Flaky (${flaky})</div>
      </div>
    </div>
  </div>

  <!-- History charts -->
  <div class="history-section">
    <h2>&#128200; Trend History (last ${history.length} run${history.length === 1 ? "" : "s"})</h2>
    <div class="history-row">
      <div class="history-card">
        <div class="chart-title">Pass Rate History (%)</div>
        ${passRateChartHtml}
        <div class="chart-legend-row" style="margin-top:8px">
          <span><span class="dot" style="background:#7c3aed"></span>Pass Rate % <em style="font-style:normal;font-size:.7rem;color:#94a3b8">(left axis)</em></span>
          <span><span class="dot" style="background:#22c55e"></span>Passed <em style="font-style:normal;font-size:.7rem;color:#94a3b8">(right axis)</em></span>
          <span><span class="dot" style="background:#ef4444"></span>Failed <em style="font-style:normal;font-size:.7rem;color:#94a3b8">(right axis)</em></span>
          <span style="font-size:.7rem;color:#94a3b8">&#9679; dot: green=100% &nbsp; amber&#8805;80% &nbsp; red&lt;80%</span>
        </div>
      </div>
      <div class="history-card">
        <div class="chart-title">Total Test Scenarios History</div>
        ${totalChartHtml}
        <div class="chart-legend-row">
          <span><span class="dot" style="background:#22c55e"></span>Passed</span>
          <span><span class="dot" style="background:#ef4444"></span>Failed</span>
          <span><span class="dot" style="background:#f59e0b"></span>Skipped</span>
          <span><span class="dot" style="background:#a855f7"></span>Flaky</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Results by feature -->
  <div class="history-section">
    <h2>&#127919; Results by Feature (${featureStats.length} feature${featureStats.length === 1 ? "" : "s"})</h2>
    <div class="history-card" style="max-width:640px">
      <div class="chart-title">Pass / Fail breakdown per tests/ subfolder</div>
      ${featureChartHtml}
      <div class="chart-legend-row" style="margin-top:10px">
        <span><span class="dot" style="background:#22c55e"></span>Passed</span>
        <span><span class="dot" style="background:#ef4444"></span>Failed</span>
        <span><span class="dot" style="background:#f59e0b"></span>Skipped</span>
        <span><span class="dot" style="background:#a855f7"></span>Flaky</span>
      </div>
    </div>
  </div>

  <!-- Filters + Search -->
  <div class="filters" id="filterBar">
    <button class="filter-btn active" data-filter="all">All (${total})</button>
    <button class="filter-btn" data-filter="pass">&#10003; Pass (${passed})</button>
    <button class="filter-btn" data-filter="fail">&#10007; Fail (${failed})</button>
    <button class="filter-btn" data-filter="skip">&#9654; Skip (${skipped})</button>
    ${flaky > 0 ? `<button class="filter-btn" data-filter="flaky">&#8635; Flaky (${flaky})</button>` : ""}
    <div class="search-wrap">
      <input type="text" id="searchInput" placeholder="Search test name, file, project..." />
    </div>
  </div>

  <!-- Results table -->
  <div class="table-wrap">
    <table id="resultsTable">
      <thead>
        <tr>
          <th>#</th>
          <th>Test</th>
          <th>Suite</th>
          <th>File</th>
          <th>Status</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        ${rows}
      </tbody>
    </table>
  </div>

</main>

<div id="chartTooltip" class="chart-tooltip" aria-hidden="true"></div>

<footer>Generated by generate-html-report.js &mdash; ${escapeHtml(runDate)}</footer>

<script>
  /* ---- Embedded data (safe for <script> context) ---- */
  var CHART_HIST    = ${safeJson(history)};
  var CHART_FEATURE = ${safeJson(featureStats)};
  var CHART_STATS   = { passed:${passed}, failed:${failed}, skipped:${skipped}, flaky:${flaky}, total:${total}, passRate:${passRate} };

  /* ---- Filter + Search ---- */
  var filterBar   = document.getElementById("filterBar");
  var tableBody   = document.getElementById("tableBody");
  var searchInput = document.getElementById("searchInput");
  var currentFilter = "all";

  function applyFilters() {
    var query = searchInput.value.toLowerCase();
    tableBody.querySelectorAll("tr").forEach(function(row) {
      var matchFilter = currentFilter === "all" || row.dataset.status === currentFilter;
      var matchSearch = !query || row.textContent.toLowerCase().includes(query);
      row.classList.toggle("hidden", !(matchFilter && matchSearch));
    });
  }
  filterBar.addEventListener("click", function(e) {
    var btn = e.target.closest(".filter-btn");
    if (!btn) return;
    filterBar.querySelectorAll(".filter-btn").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    applyFilters();
  });
  searchInput.addEventListener("input", applyFilters);

  /* ---- Canvas utilities ---- */
  var DPR = window.devicePixelRatio || 1;
  var C = {
    pass:"#22c55e", fail:"#ef4444", skip:"#f59e0b", flaky:"#a855f7",
    purple:"#7c3aed", grid:"#e2e8f0", axis:"#cbd5e1",
    tg:"#64748b", td:"#334155", tl:"#94a3b8"
  };

  function setupCanvas(id) {
    var canvas = document.getElementById(id);
    if (!canvas) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    canvas.width  = Math.round(rect.width  * DPR);
    canvas.height = Math.round(rect.height * DPR);
    var ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);
    ctx._W = rect.width;
    ctx._H = rect.height;
    return ctx;
  }

  function rr(ctx, x, y, w, h, r) {
    var m = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + m, y);
    ctx.arcTo(x + w, y,     x + w, y + h, m);
    ctx.arcTo(x + w, y + h, x,     y + h, m);
    ctx.arcTo(x,     y + h, x,     y,     m);
    ctx.arcTo(x,     y,     x + w, y,     m);
    ctx.closePath();
  }

  function rotLabel(ctx, text, x, y, ang) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  function xDateLabel(d) {
    return String(d.getMonth() + 1).padStart(2, "0") + "/" +
           String(d.getDate()).padStart(2, "0")       + " " +
           String(d.getHours()).padStart(2, "0")      + ":" +
           String(d.getMinutes()).padStart(2, "0");
  }

  /* ---- Donut chart ---- */
  function drawDonut() {
    var ctx = setupCanvas("canvasDonut");
    if (!ctx) return;
    var W = ctx._W, H = ctx._H, cx = W / 2, cy = H / 2;
    var r = Math.min(W, H) / 2 * 0.82, inner = r * 0.58;
    var segs = [
      { v: CHART_STATS.passed,  c: C.pass  },
      { v: CHART_STATS.failed,  c: C.fail  },
      { v: CHART_STATS.skipped, c: C.skip  },
      { v: CHART_STATS.flaky,   c: C.flaky },
    ];
    var tot = CHART_STATS.total || 1, ang = -Math.PI / 2, anyDrawn = false;
    segs.forEach(function(s) {
      if (s.v <= 0) return;
      anyDrawn = true;
      var sweep = (s.v / tot) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ang, ang + sweep); ctx.closePath();
      ctx.fillStyle = s.c; ctx.fill();
      ang += sweep;
    });
    if (!anyDrawn) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#e2e8f0"; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; ctx.fill();
    var fs = Math.max(10, Math.floor(r * 0.26));
    ctx.fillStyle = "#1e293b"; ctx.font = "bold " + fs + "px -apple-system,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(CHART_STATS.passRate + "%", cx, cy);
  }

  /* ---- Pass Rate History (dual Y-axis) ---- */
  function drawPassRate() {
    var ctx = setupCanvas("canvasPassRate");
    if (!ctx) return;
    var W = ctx._W, H = ctx._H, hist = CHART_HIST;
    if (hist.length < 2) {
      ctx.fillStyle = C.tl; ctx.font = "13px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Run at least 2 times to see trend", W / 2, H / 2); return;
    }
    var PT = 20, PR = 52, PB = 52, PL = 50;
    var cW = W - PL - PR, cH = H - PT - PB, n = hist.length;
    var xStep = n > 1 ? cW / (n - 1) : 0;
    var rawMax = Math.max.apply(null, hist.map(function(h) { return Math.max(h.passed, h.failed); }).concat([1]));
    var rightMax = Math.max(Math.ceil(rawMax / 5) * 5, 5);
    var xs  = hist.map(function(_, i) { return PL + i * xStep; });
    var rY  = hist.map(function(h) { return PT + cH - (h.passRate / 100)      * cH; });
    var paY = hist.map(function(h) { return PT + cH - (h.passed   / rightMax) * cH; });
    var faY = hist.map(function(h) { return PT + cH - (h.failed   / rightMax) * cH; });

    /* store dot positions for tooltip */
    document.getElementById("canvasPassRate")._dots = hist.map(function(h, i) { return { x: xs[i], y: rY[i], h: h }; });

    /* grid + left axis (purple %) */
    ctx.lineWidth = 1; ctx.font = "10px sans-serif";
    [0, 25, 50, 75, 100].forEach(function(v) {
      var y = PT + cH - (v / 100) * cH;
      ctx.strokeStyle = C.grid; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
      ctx.fillStyle = C.purple; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(v + "%", PL - 6, y);
    });
    /* right axis (count) */
    ctx.fillStyle = C.tg; ctx.textAlign = "left";
    for (var ri = 0; ri <= 4; ri++) {
      var rv = Math.round((rightMax / 4) * ri);
      ctx.fillText(rv, W - PR + 6, PT + cH - (rv / rightMax) * cH);
    }
    /* axis border lines */
    ctx.strokeStyle = C.axis; ctx.setLineDash([]);
    [[PL, PT, PL, PT + cH], [PL, PT + cH, W - PR, PT + cH], [W - PR, PT, W - PR, PT + cH]].forEach(function(s) {
      ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.stroke();
    });
    /* area fill under rate line */
    ctx.beginPath(); ctx.moveTo(xs[0], rY[0]);
    for (var ai = 1; ai < n; ai++) ctx.lineTo(xs[ai], rY[ai]);
    ctx.lineTo(xs[n-1], PT+cH); ctx.lineTo(xs[0], PT+cH); ctx.closePath();
    ctx.fillStyle = "rgba(124,58,237,0.07)"; ctx.fill();
    /* passed dashed (green) */
    ctx.strokeStyle = C.pass; ctx.lineWidth = 1.8; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(xs[0], paY[0]);
    for (var pi = 1; pi < n; pi++) ctx.lineTo(xs[pi], paY[pi]); ctx.stroke();
    /* failed dashed (red) */
    ctx.strokeStyle = C.fail;
    ctx.beginPath(); ctx.moveTo(xs[0], faY[0]);
    for (var fi = 1; fi < n; fi++) ctx.lineTo(xs[fi], faY[fi]); ctx.stroke();
    /* rate solid (purple) */
    ctx.strokeStyle = C.purple; ctx.lineWidth = 2.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(xs[0], rY[0]);
    for (var li = 1; li < n; li++) ctx.lineTo(xs[li], rY[li]); ctx.stroke();
    /* dots on rate line */
    hist.forEach(function(h, i) {
      var fill = h.passRate === 100 ? C.pass : h.passRate >= 80 ? C.skip : C.fail;
      ctx.beginPath(); ctx.arc(xs[i], rY[i], 5, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.setLineDash([]); ctx.stroke();
    });
    /* x labels */
    var lstep = Math.max(1, Math.ceil(n / 7));
    ctx.fillStyle = C.tg; ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    hist.forEach(function(h, i) {
      if (i % lstep !== 0 && i !== n - 1) return;
      rotLabel(ctx, xDateLabel(new Date(h.date)), xs[i], PT + cH + 22, -35 * Math.PI / 180);
    });
  }

  /* ---- Total Scenarios History (stacked bars) ---- */
  function drawTotal() {
    var ctx = setupCanvas("canvasTotal");
    if (!ctx) return;
    var W = ctx._W, H = ctx._H, hist = CHART_HIST;
    if (!hist.length) {
      ctx.fillStyle = C.tl; ctx.font = "13px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No data yet", W / 2, H / 2); return;
    }
    var PT = 16, PR = 16, PB = 52, PL = 44;
    var cW = W - PL - PR, cH = H - PT - PB, n = hist.length;
    var maxT = Math.max.apply(null, hist.map(function(h) { return h.total; }).concat([1]));
    var slot = cW / n, barW = Math.max(4, slot * 0.65);
    /* grid */
    ctx.lineWidth = 1; ctx.font = "10px sans-serif";
    for (var gi = 0; gi <= 4; gi++) {
      var gv = Math.round((maxT / 4) * gi), gy = PT + cH - (gv / maxT) * cH;
      ctx.strokeStyle = C.grid; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(PL, gy); ctx.lineTo(W - PR, gy); ctx.stroke();
      ctx.fillStyle = C.tl; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(gv, PL - 6, gy);
    }
    /* bars */
    hist.forEach(function(h, i) {
      var cx = PL + i * slot + slot / 2, x = cx - barW / 2, yOff = 0;
      [
        { v: h.passed,  c: C.pass  }, { v: h.failed,  c: C.fail  },
        { v: h.skipped, c: C.skip  }, { v: h.flaky,   c: C.flaky },
      ].forEach(function(s) {
        if (s.v <= 0) return;
        var bh = (s.v / maxT) * cH, by = PT + cH - yOff - bh;
        ctx.fillStyle = s.c; ctx.fillRect(x, by, barW, bh);
        yOff += bh;
      });
    });
    /* x labels */
    var lstep = Math.max(1, Math.ceil(n / 7));
    ctx.fillStyle = C.tg; ctx.font = "9px sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    hist.forEach(function(h, i) {
      if (i % lstep !== 0 && i !== n - 1) return;
      rotLabel(ctx, xDateLabel(new Date(h.date)), PL + i * slot + slot / 2, PT + cH + 22, -35 * Math.PI / 180);
    });
  }

  /* ---- Results by Feature (horizontal stacked bars) ---- */
  function drawFeature() {
    var ctx = setupCanvas("canvasFeature");
    if (!ctx) return;
    var W = ctx._W, H = ctx._H, features = CHART_FEATURE;
    if (!features.length) {
      ctx.fillStyle = C.tl; ctx.font = "13px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No test data", W / 2, H / 2); return;
    }
    var ROW_H = 36, BAR_H = 20, PL = 110, PR = 90, PT = 8;
    var bAreaW = W - PL - PR;
    var maxT = Math.max.apply(null, features.map(function(f) { return f.total; }).concat([1]));
    features.forEach(function(f, i) {
      var rowY = PT + i * ROW_H, barY = rowY + (ROW_H - BAR_H) / 2;
      if (i % 2 === 1) { ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, rowY, W, ROW_H); }
      /* feature name */
      ctx.fillStyle = C.td; ctx.font = "11px -apple-system,sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(f.name, PL - 8, barY + BAR_H / 2);
      /* background track */
      ctx.fillStyle = "#e2e8f0"; rr(ctx, PL, barY, bAreaW, BAR_H, 3); ctx.fill();
      /* clipped stacked segments */
      var totalW = (f.total / maxT) * bAreaW;
      ctx.save(); rr(ctx, PL, barY, Math.max(totalW, 0.5), BAR_H, 3); ctx.clip();
      var xOff = 0;
      [
        { v: f.passed,  c: C.pass  }, { v: f.failed,  c: C.fail  },
        { v: f.skipped, c: C.skip  }, { v: f.flaky,   c: C.flaky },
      ].forEach(function(s) {
        if (s.v <= 0) return;
        var bw = (s.v / maxT) * bAreaW;
        ctx.fillStyle = s.c; ctx.fillRect(PL + xOff, barY, bw, BAR_H);
        xOff += bw;
      });
      ctx.restore();
      /* right labels */
      var rate = f.total > 0 ? ((f.passed / f.total) * 100).toFixed(0) : "0";
      var rc   = +rate >= 80 ? "#15803d" : +rate >= 50 ? "#b45309" : "#b91c1c";
      ctx.fillStyle = C.tg; ctx.font = "10px sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(f.passed + "/" + f.total, PL + bAreaW + 8, barY + BAR_H / 2);
      ctx.fillStyle = rc; ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(rate + "%", W - 2, barY + BAR_H / 2);
    });
  }

  /* ---- Render all charts + setup tooltip ---- */
  function renderAll() {
    drawDonut();
    drawPassRate();
    drawTotal();
    drawFeature();
    setupTooltip();
  }
  renderAll();
  var _rt;
  window.addEventListener("resize", function() { clearTimeout(_rt); _rt = setTimeout(renderAll, 150); });

  /* ---- Tooltip for Pass Rate dots ---- */
  var chartTooltip = document.getElementById("chartTooltip");

  function moveTooltip(e) {
    var pad = 14, tw = chartTooltip.offsetWidth, th = chartTooltip.offsetHeight;
    var x = e.clientX + pad, y = e.clientY - th / 2;
    if (x + tw > window.innerWidth  - 4) x = e.clientX - tw - pad;
    if (y < 4)                            y = 4;
    if (y + th > window.innerHeight - 4) y = window.innerHeight - th - 4;
    chartTooltip.style.left = x + "px"; chartTooltip.style.top = y + "px";
  }

  function hideTooltip() { chartTooltip.style.display = "none"; }

  function showTooltipData(h, e) {
    var rn = h.passRate;
    var rc = rn === 100 ? "#4ade80" : rn >= 80 ? "#fbbf24" : "#f87171";
    chartTooltip.innerHTML =
      '<div class="tt-label">' + h.label + '</div>' +
      '<div class="tt-rate" style="color:' + rc + '">' + h.passRate + '%</div>' +
      '<div class="tt-row">' +
        '<span class="tt-pass">&#10003; Passed: ' + h.passed + '</span>' +
        '<span class="tt-fail">&#10007; Failed: ' + h.failed + '</span>' +
      '</div>' +
      '<div class="tt-total">Total: ' + h.total + ' scenarios</div>';
    chartTooltip.style.display = "block";
    moveTooltip(e);
  }

  function setupTooltip() {
    var canvas = document.getElementById("canvasPassRate");
    if (!canvas) return;
    if (canvas._mmH) { canvas.removeEventListener("mousemove", canvas._mmH); canvas.removeEventListener("mouseleave", canvas._mlH); }
    canvas._mmH = function(e) {
      var rect = canvas.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var dots = canvas._dots || [], hit = null;
      for (var i = 0; i < dots.length; i++) {
        if (Math.hypot(dots[i].x - mx, dots[i].y - my) <= 10) { hit = dots[i]; break; }
      }
      canvas.style.cursor = hit ? "pointer" : "default";
      if (hit) showTooltipData(hit.h, e); else hideTooltip();
    };
    canvas._mlH = function() { hideTooltip(); canvas.style.cursor = "default"; };
    canvas.addEventListener("mousemove", canvas._mmH);
    canvas.addEventListener("mouseleave", canvas._mlH);
  }
</script>

</body>
</html>`;

fs.writeFileSync(OUTPUT_FILE, html, "utf-8");
console.log(`✅  Custom report generated: ${OUTPUT_FILE}`);
console.log(`   Total: ${total}  |  Pass: ${passed}  |  Fail: ${failed}  |  Skip: ${skipped}  |  Flaky: ${flaky}`);
