#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const REPORT_INPUT  = path.resolve(__dirname, '../test-results/test-results.json');
const REPORT_OUTPUT = path.resolve(__dirname, '../reports/index.html');
const HISTORY_FILE  = path.resolve(__dirname, '../reports/pass-rate-history.json');
const MAX_HISTORY   = 30;


// Ensure the reports output directory exists
const REPORTS_DIR = path.dirname(REPORT_OUTPUT);
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}

function statusColor(status) {
  switch (status) {
    case 'passed':  return '#22c55e';
    case 'failed':  return '#ef4444';
    case 'flaky':   return '#f59e0b';
    case 'skipped': return '#6b7280';
    default:        return '#a855f7';
  }
}

/** Extract the top-level folder (feature) from a Playwright spec file path. */
function getFeature(filePath) {
  if (!filePath) return '(unknown)';
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length > 1) return parts[0];
  return parts[0].replace(/\.(spec|test)\.(ts|js|tsx|jsx)$/, '').replace(/\.(ts|js)$/, '') || '(root)';
}

function loadReport(filePath) {
  if (!fs.existsSync(filePath)) { console.error('Report not found: ' + filePath); process.exit(1); }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), 'utf8'); }

// ─── Data Processing ──────────────────────────────────────────────────────────

/**
 * Recursively flatten Playwright JSON suites into individual test records.
 * Playwright JSON format:
 *   data.suites[] -> .suites[] -> .specs[] -> .tests[] -> .results[]
 */
function flattenSuites(suites, parentTitle) {
  parentTitle = parentTitle || '';
  const records = [];
  for (const suite of (suites || [])) {
    const suiteTitle = parentTitle ? parentTitle + ' > ' + suite.title : suite.title;
    for (const spec of (suite.specs || [])) {
      for (const test of (spec.tests || [])) {
        const result = (test.results || [])[0] || {};
        let status;
        switch (test.status) {
          case 'expected':   status = result.status === 'passed' ? 'passed' : 'skipped'; break;
          case 'unexpected': status = 'failed';  break;
          case 'flaky':      status = 'flaky';   break;
          case 'skipped':    status = 'skipped'; break;
          default:           status = result.status === 'passed' ? 'passed' : 'failed';
        }
        const errorMsg =
          (result.error  && result.error.message)          ||
          ((result.errors || [])[0] && result.errors[0].message) || '';
        records.push({
          feature:    getFeature(spec.file || ''),
          suiteTitle: suiteTitle,
          title:      spec.title  || '',
          project:    test.projectName || '',
          status,
          durationMs: result.duration || 0,
          errorMsg,
          retries:    Math.max(0, (test.results || []).length - 1),
          file:       spec.file || '',
          line:       spec.line || 0,
        });
      }
    }
    if ((suite.suites || []).length) {
      records.push(...flattenSuites(suite.suites, suiteTitle));
    }
  }
  return records;
}

function processData(rawData) {
  const scenarios = flattenSuites(rawData.suites || []);
  let totalPassed = 0, totalFailed = 0, totalFlaky = 0, totalSkipped = 0;
  const featureMap = new Map();
  const projectMap = new Map();

  for (const s of scenarios) {
    if      (s.status === 'passed')  totalPassed++;
    else if (s.status === 'failed')  totalFailed++;
    else if (s.status === 'flaky')   totalFlaky++;
    else                             totalSkipped++;

    if (!featureMap.has(s.feature))
      featureMap.set(s.feature, { name: s.feature, passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 });
    const proj = s.project || 'default';
    if (!projectMap.has(proj))
      projectMap.set(proj, { passed: 0, failed: 0, pending: 0, skipped: 0 });

    const fe = featureMap.get(s.feature);
    const pe = projectMap.get(proj);
    if      (s.status === 'passed')  { fe.passed++;  pe.passed++;  }
    else if (s.status === 'failed')  { fe.failed++;  pe.failed++;  }
    else if (s.status === 'flaky')   { fe.pending++; pe.pending++; }   // reuse pending slot for flaky
    else                             { fe.skipped++; pe.skipped++; }
    fe.total++;
  }

  const featureSummaries = [...featureMap.values()].sort((a, b) => b.total - a.total);
  const tagSummary = [...projectMap.entries()]
    .map(([tag, c]) => ({ tag, ...c, total: c.passed + c.failed + c.pending + c.skipped }))
    .sort((a, b) => b.total - a.total);

  const totalScenarios  = totalPassed + totalFailed + totalFlaky + totalSkipped;
  const passRate        = totalScenarios > 0 ? ((totalPassed / totalScenarios) * 100).toFixed(1) : '0.0';
  const totalDurationMs = scenarios.reduce((s, t) => s + t.durationMs, 0);

  return {
    scenarios, featureSummaries, tagSummary,
    totalPassed, totalFailed,
    totalPending: totalFlaky,   // flaky → "pending" slot for chart compatibility
    totalSkipped, totalScenarios, passRate, totalDurationMs,
  };
}

// ─── HTML Builder ─────────────────────────────────────────────────────────────

function buildHTML(data, history, generatedAt) {
  const {
    scenarios, featureSummaries, tagSummary,
    totalPassed, totalFailed, totalPending, totalSkipped,
    totalScenarios, passRate, totalDurationMs,
  } = data;

  const sj = v => JSON.stringify(v);

  const featureLabels  = sj(featureSummaries.map(f => f.name));
  const featurePassed  = sj(featureSummaries.map(f => f.passed));
  const featureFailed  = sj(featureSummaries.map(f => f.failed));
  const featurePending = sj(featureSummaries.map(f => f.pending));

  const tagLabels  = sj(tagSummary.map(t => t.tag));
  const tagPassed  = sj(tagSummary.map(t => t.passed));
  const tagFailed  = sj(tagSummary.map(t => t.failed));
  const tagPending = sj(tagSummary.map(t => t.pending));
  const tagSkipped = sj(tagSummary.map(t => t.skipped));
  const tagTotals  = sj(tagSummary.map(t => t.total));

  const scenarioLabels    = sj(scenarios.map(s => s.title));
  const scenarioDurations = sj(scenarios.map(s => s.durationMs));
  const scenarioColors    = sj(scenarios.map(s => statusColor(s.status)));

  const failedScenarios  = scenarios.filter(s => s.status === 'failed');
  const failureLabels    = sj(failedScenarios.map(s => s.title));
  const failureDurations = sj(failedScenarios.map(s => s.durationMs));

  const historyLabels    = sj(history.map(h => h.label));
  const historyPassRates = sj(history.map(h => h.passRate));
  const historyPassed    = sj(history.map(h => h.passed));
  const historyFailed    = sj(history.map(h => h.failed));
  const historyPending   = sj(history.map(h => h.pending  || 0));
  const historySkipped   = sj(history.map(h => h.skipped  || 0));
  const historyTotal     = sj(history.map(h => h.total));

  const slowest       = [...scenarios].sort((a, b) => b.durationMs - a.durationMs).slice(0, 15);
  const stepLabels    = sj(slowest.map(s => s.title.length > 45 ? s.title.slice(0, 43) + '...' : s.title));
  const stepDurations = sj(slowest.map(s => s.durationMs));
  const stepColors    = sj(slowest.map(s => statusColor(s.status)));

  const tableRows = scenarios.map(s => {
    const badge = `<span class="badge badge-${s.status}">${s.status.toUpperCase()}</span>`;
    const proj  = s.project ? `<span class="tag-pill">${escapeHtml(s.project)}</span>` : '';
    const retry = s.retries > 0 ? ` <span class="retry-badge">&#8635;${s.retries}</span>` : '';
    const err   = s.errorMsg
      ? `<tr class="error-row" data-status="${s.status}"><td colspan="6"><pre class="error-pre">${
          escapeHtml(s.errorMsg.slice(0, 400))}${s.errorMsg.length > 400 ? '...' : ''}</pre></td></tr>`
      : '';
    return `
      <tr class="scenario-row" data-status="${s.status}">
        <td>${escapeHtml(s.feature)}</td>
        <td>${escapeHtml(s.title)}${retry}</td>
        <td>${proj}</td>
        <td>${badge}</td>
        <td class="duration-cell">${s.durationMs} ms</td>
        <td class="file-cell">${escapeHtml(s.file)}${s.line ? ':' + s.line : ''}</td>
      </tr>${err}`;
  }).join('');

  const overallClass  = totalFailed > 0 ? 'failed' : 'passed';
  const overallStatus = totalFailed > 0 ? 'FAILED' : 'PASSED';
  const totalSec      = (totalDurationMs / 1000).toFixed(2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Playwright Test Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
    .header{background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border-bottom:1px solid #334155;padding:24px 32px;display:flex;align-items:center;justify-content:space-between}
    .header-title{font-size:1.6rem;font-weight:700;color:#f8fafc}.header-title span{color:#38bdf8}
    .header-meta{font-size:.8rem;color:#94a3b8;text-align:right}
    .overall-badge{display:inline-block;padding:4px 14px;border-radius:9999px;font-size:.85rem;font-weight:700;letter-spacing:.05em}
    .overall-badge.passed{background:#14532d;color:#4ade80}.overall-badge.failed{background:#450a0a;color:#f87171}
    .container{max-width:1400px;margin:0 auto;padding:24px 32px}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:32px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;text-align:center}
    .card-value{font-size:2.4rem;font-weight:800;line-height:1}.card-label{font-size:.75rem;color:#94a3b8;margin-top:6px;text-transform:uppercase;letter-spacing:.08em}
    .card.total .card-value{color:#38bdf8}.card.passed .card-value{color:#4ade80}.card.failed .card-value{color:#f87171}
    .card.flaky .card-value{color:#fbbf24}.card.skipped .card-value{color:#9ca3af}.card.rate .card-value{color:#a78bfa}
    .card.duration .card-value{font-size:1.6rem;color:#38bdf8}
    .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:32px}
    .charts-grid.full{grid-template-columns:1fr}
    @media(max-width:900px){.charts-grid{grid-template-columns:1fr}}
    .chart-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px}
    .chart-title{font-size:1rem;font-weight:600;color:#f1f5f9;margin-bottom:16px;display:flex;align-items:center;gap:8px}
    .chart-title::before{content:'';display:inline-block;width:4px;height:18px;border-radius:2px;background:#38bdf8}
    .chart-container{position:relative;height:280px}.chart-container.tall{height:360px}
    .no-data{text-align:center;color:#64748b;padding:60px 0;font-size:.9rem}
    .section-title{font-size:1.1rem;font-weight:700;color:#f1f5f9;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #334155}
    .filter-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .filter-btn{padding:6px 16px;border-radius:9999px;border:1px solid #334155;background:#1e293b;color:#94a3b8;cursor:pointer;font-size:.8rem;transition:all .15s}
    .filter-btn:hover,.filter-btn.active{background:#38bdf8;color:#0f172a;border-color:#38bdf8;font-weight:600}
    .table-wrap{overflow-x:auto;border-radius:12px;border:1px solid #334155;margin-bottom:32px}
    table{width:100%;border-collapse:collapse;font-size:.875rem}
    thead{background:#1e293b}
    th{padding:12px 16px;text-align:left;font-weight:600;color:#94a3b8;text-transform:uppercase;font-size:.75rem;letter-spacing:.06em;border-bottom:1px solid #334155}
    td{padding:12px 16px;border-bottom:1px solid #1e293b;vertical-align:top;color:#cbd5e1}
    tr:last-child td{border-bottom:none}
    tr.scenario-row:hover td{background:#1a2744}
    tr.scenario-row.hidden-row,tr.error-row.hidden-row{display:none}
    tr:nth-child(even) td{background:#182032}
    tr:nth-child(even):hover td{background:#1a2744}
    .badge{display:inline-block;padding:2px 10px;border-radius:9999px;font-size:.72rem;font-weight:700;letter-spacing:.05em}
    .badge-passed{background:#14532d;color:#4ade80}.badge-failed{background:#450a0a;color:#f87171}
    .badge-flaky{background:#451a03;color:#fbbf24}.badge-skipped{background:#1e293b;color:#9ca3af}
    .duration-cell{font-family:'Courier New',monospace;color:#94a3b8}
    .file-cell{font-family:'Courier New',monospace;font-size:.78rem;color:#64748b}
    .retry-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:.7rem;background:#451a03;color:#fde68a;margin-left:6px}
    .tag-pill{display:inline-block;padding:1px 8px;border-radius:9999px;font-size:.7rem;font-weight:600;background:#1e3a5f;color:#7dd3fc;border:1px solid #1d4ed8}
    .error-row td{padding:0 16px 12px}
    .error-pre{background:#1a0a0a;border:1px solid #450a0a;border-radius:6px;padding:10px;font-size:.75rem;color:#fca5a5;white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;max-height:120px;overflow-y:auto}
    .history-note{font-size:.75rem;color:#64748b;margin-top:8px;text-align:right}
    .footer{text-align:center;padding:32px;color:#475569;font-size:.8rem;border-top:1px solid #1e293b;margin-top:32px}
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title"><span>Playwright</span> Test Report</div>
      <div class="header-meta" style="margin-top:6px">Generated: ${generatedAt}</div>
    </div>
    <div style="text-align:right">
      <span class="overall-badge ${overallClass}">${overallStatus}</span>
      <div class="header-meta" style="margin-top:4px">${totalScenarios} test(s) &middot; ${totalSec}s</div>
    </div>
  </div>

  <div class="container">

    <div class="cards">
      <div class="card total">   <div class="card-value">${totalScenarios}</div><div class="card-label">Total</div></div>
      <div class="card passed">  <div class="card-value">${totalPassed}</div>   <div class="card-label">Passed</div></div>
      <div class="card failed">  <div class="card-value">${totalFailed}</div>   <div class="card-label">Failed</div></div>
      <div class="card flaky">   <div class="card-value">${totalPending}</div>  <div class="card-label">Flaky</div></div>
      <div class="card skipped"> <div class="card-value">${totalSkipped}</div>  <div class="card-label">Skipped</div></div>
      <div class="card rate">    <div class="card-value">${passRate}%</div>     <div class="card-label">Pass Rate</div></div>
      <div class="card duration"><div class="card-value">${totalSec}s</div>     <div class="card-label">Duration</div></div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">Test Results Overview</div>
        <div class="chart-container"><canvas id="resultsChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Results by Feature</div>
        <div class="chart-container"><canvas id="featureChart"></canvas></div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">Benchmarks &mdash; Test Duration (ms)</div>
        <div class="chart-container"><canvas id="benchmarkChart"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Failed Tests</div>
        <div class="chart-container">
          ${failedScenarios.length === 0
            ? '<div class="no-data">No failures detected &#10003;</div>'
            : '<canvas id="failuresChart"></canvas>'}
        </div>
      </div>
    </div>

    <div class="charts-grid full">
      <div class="chart-card">
        <div class="chart-title">Results by Browser / Project</div>
        ${tagSummary.length === 0
          ? '<div class="no-data">No project data found</div>'
          : '<div class="chart-container"><canvas id="tagChart"></canvas></div>'}
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">Pass Rate History</div>
        ${history.length < 2
          ? `<div class="no-data">Run more tests to see trend (${history.length}/2 recorded)</div>`
          : `<div class="chart-container"><canvas id="historyChart"></canvas></div>
             <div class="history-note">Last ${history.length} run(s) &middot; max ${MAX_HISTORY} stored</div>`}
      </div>
      <div class="chart-card">
        <div class="chart-title">Total Tests History</div>
        ${history.length < 2
          ? `<div class="no-data">Run more tests to see trend (${history.length}/2 recorded)</div>`
          : `<div class="chart-container"><canvas id="totalScenariosChart"></canvas></div>
             <div class="history-note">Last ${history.length} run(s) &middot; max ${MAX_HISTORY} stored</div>`}
      </div>
    </div>

    <div class="charts-grid full">
      <div class="chart-card">
        <div class="chart-title">Top 15 Slowest Tests (ms)</div>
        <div class="chart-container tall"><canvas id="stepChart"></canvas></div>
      </div>
    </div>

    <div class="section-title">Detailed Results</div>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterTable('all',this)">All (${totalScenarios})</button>
      <button class="filter-btn" onclick="filterTable('passed',this)">Passed (${totalPassed})</button>
      <button class="filter-btn" onclick="filterTable('failed',this)">Failed (${totalFailed})</button>
      ${totalPending > 0 ? `<button class="filter-btn" onclick="filterTable('flaky',this)">Flaky (${totalPending})</button>` : ''}
      ${totalSkipped > 0 ? `<button class="filter-btn" onclick="filterTable('skipped',this)">Skipped (${totalSkipped})</button>` : ''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Feature</th><th>Test</th><th>Project</th><th>Status</th><th>Duration</th><th>File</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>

  </div>
  <div class="footer">Playwright HTML Reporter &mdash; ${generatedAt}</div>

<script>
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.borderColor = '#334155';
  Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  // 1. Results Doughnut
  new Chart(document.getElementById('resultsChart'), {
    type: 'doughnut',
    data: {
      labels: ['Passed','Failed','Flaky','Skipped'],
      datasets: [{ data: [${totalPassed},${totalFailed},${totalPending},${totalSkipped}],
        backgroundColor: ['#22c55e','#ef4444','#f59e0b','#6b7280'],
        borderColor: '#0f172a', borderWidth: 3, hoverOffset: 8 }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: { legend: { position: 'right', labels: { padding: 20, usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => ' '+ctx.label+': '+ctx.parsed+' ('+(ctx.parsed/${totalScenarios || 1}*100).toFixed(1)+'%)' } } } },
  });

  // 2. Feature bar
  new Chart(document.getElementById('featureChart'), {
    type: 'bar',
    data: { labels: ${featureLabels},
      datasets: [
        { label: 'Passed', data: ${featurePassed}, backgroundColor: '#22c55e', borderRadius: 4 },
        { label: 'Failed', data: ${featureFailed}, backgroundColor: '#ef4444', borderRadius: 4 },
        { label: 'Flaky',  data: ${featurePending}, backgroundColor: '#f59e0b', borderRadius: 4 },
      ] },
    options: { responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 30 } },
                y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } },
      plugins: { legend: { position: 'top' } } },
  });

  // 3. Benchmark — Test Duration
  new Chart(document.getElementById('benchmarkChart'), {
    type: 'bar',
    data: { labels: ${scenarioLabels},
      datasets: [{ label: 'Duration (ms)', data: ${scenarioDurations}, backgroundColor: ${scenarioColors}, borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { beginAtZero: true, title: { display: true, text: 'ms' } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } } },
  });

  // 4. Failed Tests
  ${failedScenarios.length > 0 ? `
  new Chart(document.getElementById('failuresChart'), {
    type: 'bar',
    data: { labels: ${failureLabels},
      datasets: [{ label: 'Duration (ms)', data: ${failureDurations},
        backgroundColor: '#ef4444', borderColor: '#fca5a5', borderWidth: 1, borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { beginAtZero: true, title: { display: true, text: 'ms' } }, y: { grid: { display: false } } },
      plugins: { legend: { display: false } } },
  });` : ''}

  // 5. Results by Browser / Project
  ${tagSummary.length > 0 ? `
  new Chart(document.getElementById('tagChart'), {
    type: 'bar',
    data: { labels: ${tagLabels},
      datasets: [
        { label: 'Passed',  data: ${tagPassed},  backgroundColor: 'rgba(34,197,94,.85)',   borderColor: '#22c55e', borderWidth: 1, borderRadius: 4, stack: 'p' },
        { label: 'Failed',  data: ${tagFailed},  backgroundColor: 'rgba(239,68,68,.85)',   borderColor: '#ef4444', borderWidth: 1, borderRadius: 4, stack: 'p' },
        { label: 'Flaky',   data: ${tagPending}, backgroundColor: 'rgba(245,158,11,.85)',  borderColor: '#f59e0b', borderWidth: 1, borderRadius: 4, stack: 'p' },
        { label: 'Skipped', data: ${tagSkipped}, backgroundColor: 'rgba(107,114,128,.85)', borderColor: '#6b7280', borderWidth: 1, borderRadius: 4, stack: 'p' },
      ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Tests' }, ticks: { stepSize: 1 }, grid: { color: 'rgba(51,65,85,.5)' } } },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: { afterBody: items => { const t=${tagTotals}[items[0]?.dataIndex]; return t!=null?['','  Total: '+t]:[]; } } } } },
  });` : ''}

  // 6. Pass Rate History
  ${history.length >= 2 ? `
  new Chart(document.getElementById('historyChart'), {
    type: 'line',
    data: { labels: ${historyLabels},
      datasets: [
        { label: 'Pass Rate (%)', data: ${historyPassRates}, borderColor: '#a78bfa',
          backgroundColor: 'rgba(167,139,250,.12)',
          pointBackgroundColor: ${historyPassRates}.map(v => v===100?'#22c55e':v>=80?'#f59e0b':'#ef4444'),
          pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, tension: .35, fill: true, yAxisID: 'yRate' },
        { label: 'Passed', data: ${historyPassed}, borderColor: '#22c55e', backgroundColor: 'transparent',
          pointRadius: 3, borderWidth: 1.5, borderDash: [4,3], tension: .35, yAxisID: 'yCount' },
        { label: 'Failed', data: ${historyFailed}, borderColor: '#ef4444', backgroundColor: 'transparent',
          pointRadius: 3, borderWidth: 1.5, borderDash: [4,3], tension: .35, yAxisID: 'yCount' },
      ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: 'rgba(51,65,85,.5)' }, ticks: { maxRotation: 40, font: { size: 11 } } },
        yRate:  { position: 'left',  min: 0, max: 100, title: { display: true, text: 'Pass Rate (%)' }, ticks: { callback: v => v+'%' }, grid: { color: 'rgba(51,65,85,.5)' } },
        yCount: { position: 'right', beginAtZero: true, title: { display: true, text: 'Count' }, ticks: { stepSize: 1 }, grid: { display: false } },
      },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: {
          label: ctx => ctx.dataset.yAxisID==='yRate' ? ' Pass Rate: '+ctx.parsed.y+'%' : ' '+ctx.dataset.label+': '+ctx.parsed.y,
          afterBody: items => { const t=${historyTotal}[items[0]?.dataIndex]; return t!=null?['','  Total: '+t]:[]; },
        } } },
    },
  });

  // 7. Total Tests History
  new Chart(document.getElementById('totalScenariosChart'), {
    type: 'bar',
    data: { labels: ${historyLabels},
      datasets: [
        { label: 'Passed',  data: ${historyPassed},  backgroundColor: 'rgba(34,197,94,.85)',   borderColor: '#22c55e', borderWidth: 1, borderRadius: 3, stack: 's' },
        { label: 'Failed',  data: ${historyFailed},  backgroundColor: 'rgba(239,68,68,.85)',   borderColor: '#ef4444', borderWidth: 1, borderRadius: 3, stack: 's' },
        { label: 'Flaky',   data: ${historyPending}, backgroundColor: 'rgba(245,158,11,.85)',  borderColor: '#f59e0b', borderWidth: 1, borderRadius: 3, stack: 's' },
        { label: 'Skipped', data: ${historySkipped}, backgroundColor: 'rgba(107,114,128,.85)', borderColor: '#6b7280', borderWidth: 1, borderRadius: 3, stack: 's' },
      ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 40, font: { size: 11 } } },
                y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Tests' }, ticks: { stepSize: 1 }, grid: { color: 'rgba(51,65,85,.5)' } } },
      plugins: { legend: { position: 'top', labels: { usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: { afterBody: items => {
          const t=${historyTotal}[items[0]?.dataIndex], r=${historyPassRates}[items[0]?.dataIndex];
          return t!=null?['','  Total: '+t+'  |  Pass Rate: '+r+'%']:[];
        } } } },
    },
  });` : ''}

  // 8. Slowest Tests
  new Chart(document.getElementById('stepChart'), {
    type: 'bar',
    data: { labels: ${stepLabels}, datasets: [{ label: 'Duration (ms)', data: ${stepDurations}, backgroundColor: ${stepColors}, borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: { x: { beginAtZero: true, title: { display: true, text: 'ms' } }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } },
      plugins: { legend: { display: false } } },
  });

  function filterTable(status, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.scenario-row').forEach(row => {
      const show = status === 'all' || row.dataset.status === status;
      row.classList.toggle('hidden-row', !show);
      const next = row.nextElementSibling;
      if (next && next.classList.contains('error-row')) next.classList.toggle('hidden-row', !show);
    });
  }
</script>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('Reading:', REPORT_INPUT);
const rawData = loadReport(REPORT_INPUT);
const data    = processData(rawData);

const now         = new Date();
const generatedAt = now.toLocaleString();

// Append current run to history (deduplicate by Playwright's startTime when available)
const runTimestamp = rawData.stats && rawData.stats.startTime
  ? new Date(rawData.stats.startTime).toISOString()
  : now.toISOString();

const history = loadHistory();
if (!history.some(h => h.timestamp === runTimestamp)) {
  history.push({
    timestamp:  runTimestamp,
    label:      now.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    passRate:   parseFloat(data.passRate),
    passed:     data.totalPassed,
    failed:     data.totalFailed,
    pending:    data.totalPending,
    skipped:    data.totalSkipped,
    total:      data.totalScenarios,
    durationMs: Math.round(data.totalDurationMs),
  });
}
if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
saveHistory(history);
console.log(`History updated: ${history.length} run(s) stored in ${HISTORY_FILE}`);

const html = buildHTML(data, history, generatedAt);
fs.mkdirSync(path.dirname(REPORT_OUTPUT), { recursive: true });
fs.writeFileSync(REPORT_OUTPUT, html, 'utf8');

console.log('Report generated:', REPORT_OUTPUT);
console.log(`  Total: ${data.totalScenarios} | Passed: ${data.totalPassed} | Failed: ${data.totalFailed} | Flaky: ${data.totalPending} | Pass Rate: ${data.passRate}%`);
