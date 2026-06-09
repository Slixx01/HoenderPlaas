/* ══ Poultry Ops Dashboard ══════════════════════════════════════════════ */

let weightChart  = null;
let cumulChart   = null;
let activeChartTab = "weight";
let currentTrend   = null;
let availableDays  = [];
const CHART_COLORS = [
  "#4f8ef7","#27c97a","#f5a623","#f0524a","#7c6fff",
  "#4dd0e1","#ff7043","#ab47bc","#66bb6a","#ef5350"
];

// ── Routing ───────────────────────────────────────────────────────────────

document.querySelectorAll(".mnav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".mnav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    document.getElementById(`tab-${tab}`).classList.add("active");
  });
});

document.querySelectorAll(".subnav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const sub = btn.dataset.sub;
    document.querySelectorAll(".subnav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".sub-pane").forEach(p => p.classList.remove("active"));
    document.getElementById(`sub-${sub}`).classList.add("active");
  });
});

// ── File upload ───────────────────────────────────────────────────────────

["file-input","file-reload"].forEach(id => {
  document.getElementById(id).addEventListener("change", async e => {
    const f = e.target.files[0];
    if (f) await doUpload(f);
    e.target.value = "";
  });
});

async function doUpload(file) {
  toast("⏳ Loading workbook…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r    = await fetch("/upload", { method:"POST", body:fd });
    const data = await r.json();
    if (data.error) { toast("❌ " + data.error, "error"); return; }

    document.getElementById("upload-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    document.getElementById("hdr-meta").textContent =
      `${data.filename} · ${data.flocks.length} flocks · ${data.weight_records} weight · ${data.morts_records} mort records`;
    document.getElementById("hdr-flock").textContent =
      `Flock ${data.flocks[data.flocks.length - 1].flock}`;

    availableDays = data.available_days;
    populateSelect("w-day-select", availableDays);
    populateSelect("m-day-select", availableDays);
    renderFlocks(data.flocks);

    document.getElementById("w-flocks-panel").style.display = "block";
    toast(`✅ Loaded ${data.filename}`, "success");
    runWeightReport();
  } catch(e) {
    toast("❌ Upload failed: " + e.message, "error");
  }
}

function populateSelect(id, days) {
  const sel = document.getElementById(id);
  sel.innerHTML = '<option value="">Select…</option>';
  days.forEach(d => {
    const o = document.createElement("option");
    o.value = d; o.textContent = `Day ${d}`;
    sel.appendChild(o);
  });
  if (days.length) sel.value = days[days.length - 1];
}

// ── Weight report ─────────────────────────────────────────────────────────

document.getElementById("w-run").addEventListener("click", runWeightReport);
document.getElementById("w-day-select").addEventListener("change", runWeightReport);

async function runWeightReport() {
  const day   = parseInt(document.getElementById("w-day-select").value);
  const thr   = parseFloat(document.getElementById("w-threshold").value) || 5;
  if (!day) { toast("Please select a day", "error"); return; }

  const btn = document.getElementById("w-run");
  setLoading(btn, true);
  try {
    const r    = await fetch(`/api/weight_day?day=${day}&threshold=${thr}`);
    const data = await r.json();
    if (data.error) { toast("❌ " + data.error, "error"); return; }

    // KPIs
    qs("#w-k-flock").textContent = data.flock ?? "—";
    qs("#w-k-day").textContent   = `Day ${data.day}`;
    qs("#w-k-avg").textContent   = data.three_cycle_avg != null ? fmt(data.three_cycle_avg) : "—";
    qs("#w-k-below").textContent = data.below_avg_count;
    qs("#w-k-above").textContent = data.above_avg_count;
    show("w-kpis");

    // Table
    const tbody = qs("#w-tbody");
    tbody.innerHTML = "";
    const sorted = [...data.houses].sort((a,b) => {
      const o = {below:0,ok:1,above:2};
      return o[a.status] - o[b.status];
    });
    sorted.forEach(h => {
      const diff = h.weight != null && h.avg_weight != null
        ? (h.weight - h.avg_weight).toFixed(1) : "—";
      const diffFmt = isNaN(parseFloat(diff)) ? "—"
        : (parseFloat(diff) >= 0 ? `+${diff}` : diff);

      const pctFmt = h.pct_diff != null
        ? (h.pct_diff >= 0 ? `+${h.pct_diff.toFixed(1)}%` : `${h.pct_diff.toFixed(1)}%`) : "—";
      const pctCls = h.status === "below" ? "pct-red" : h.status === "above" ? "pct-green" : "pct-muted";
      const pillCls = `pill pill-${h.status}`;
      const pillTxt = h.status === "below" ? "⬇ Under" : h.status === "above" ? "⬆ Over" : "✓ On Track";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="h-name">${h.house}</span></td>
        <td>${h.weight != null ? fmt(h.weight) : "—"}</td>
        <td>${h.avg_weight != null ? fmt(h.avg_weight) : "—"}</td>
        <td>${diffFmt}</td>
        <td><span class="pct ${pctCls}">${pctFmt}</span></td>
        <td>${h.morts != null ? h.morts : "—"}</td>
        <td><span class="${pillCls}">${pillTxt}</span></td>`;
      tr.addEventListener("click", () => loadHouseTrend(h.house, tr));
      tbody.appendChild(tr);
    });
    show("w-table-panel");
  } finally {
    setLoading(btn, false, "Run Report");
  }
}

// ── House trend chart ─────────────────────────────────────────────────────

async function loadHouseTrend(house, rowEl) {
  document.querySelectorAll("#w-tbody tr").forEach(r => r.classList.remove("selected"));
  rowEl.classList.add("selected");
  try {
    const r    = await fetch(`/api/house_trend?house=${house}`);
    currentTrend = await r.json();
    qs("#w-chart-title").textContent = `House ${house} — Flock ${currentTrend.flock}`;
    show("w-chart-panel");
    qs("#w-chart-panel").scrollIntoView({ behavior:"smooth", block:"nearest" });
    renderWeightChart(activeChartTab);
  } catch(e) {
    toast("❌ " + e.message, "error");
  }
}

document.querySelectorAll(".pill-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pill-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeChartTab = btn.dataset.chart;
    if (currentTrend) renderWeightChart(activeChartTab);
  });
});

document.getElementById("w-close-chart").addEventListener("click", () => {
  document.getElementById("w-chart-panel").style.display = "none";
  document.querySelectorAll("#w-tbody tr").forEach(r => r.classList.remove("selected"));
  if (weightChart) { weightChart.destroy(); weightChart = null; }
  currentTrend = null;
});

function renderWeightChart(tab) {
  const ctx = qs("#w-chart").getContext("2d");
  if (weightChart) { weightChart.destroy(); weightChart = null; }
  let datasets = [], yLabel = "";

  if (tab === "weight") {
    yLabel = "Weight (g)";
    datasets = [
      {
        label: `${currentTrend.house} Weight`,
        data: currentTrend.weight.map(p => ({x:p.day, y:p.value})),
        borderColor:"#4f8ef7", backgroundColor:"rgba(79,142,247,.1)",
        borderWidth:2.5, pointRadius:3, tension:.35, fill:true
      },
      {
        label: "3-Cycle Avg",
        data: currentTrend.avg.map(p => ({x:p.day, y:p.value})),
        borderColor:"#f5a623", backgroundColor:"transparent",
        borderWidth:2, borderDash:[7,4], pointRadius:0, tension:.35
      }
    ];
  } else {
    yLabel = "Daily Morts";
    datasets = [{
      label: `${currentTrend.house} Morts`,
      data: currentTrend.morts.map(p => ({x:p.day, y:p.value})),
      borderColor:"#f0524a", backgroundColor:"rgba(240,82,74,.12)",
      borderWidth:2.5, pointRadius:3, tension:.35, fill:true
    }];
  }

  weightChart = new Chart(ctx, {
    type:"line", data:{ datasets },
    options: chartOpts(yLabel)
  });
}

// ── Flock cards ───────────────────────────────────────────────────────────

function renderFlocks(flocks) {
  const grid = qs("#w-flock-grid");
  grid.innerHTML = "";
  const max = Math.max(...flocks.map(f => f.flock));
  flocks.forEach(f => {
    const el = document.createElement("div");
    el.className = "flock-card" + (f.flock === max ? " current" : "");
    el.innerHTML = `
      <div class="fc-num">Flock ${f.flock}</div>
      <div class="fc-meta">Up to day <strong>${f.max_day}</strong></div>
      ${f.flock === max ? '<span class="fc-badge">CURRENT</span>' : ""}`;
    el.addEventListener("click", () => loadFlock(f.flock));
    grid.appendChild(el);
  });
}

async function loadFlock(flockId) {
  try {
    const r    = await fetch(`/api/available_days?flock=${flockId}`);
    const data = await r.json();
    availableDays = data.days;
    populateSelect("w-day-select", availableDays);
    populateSelect("m-day-select", availableDays);
    // highlight selected flock card
    document.querySelectorAll(".flock-card").forEach(c => c.classList.remove("selected-flock"));
    document.querySelectorAll(".flock-card").forEach(c => {
      if (c.querySelector(".fc-num").textContent === `Flock ${flockId}`) {
        c.classList.add("selected-flock");
      }
    });
    document.getElementById("hdr-flock").textContent = `Flock ${flockId}`;
    await runWeightReport();
  } catch(e) {
    toast("Could not load flock: " + e.message, "error");
  }
}

// ── Mortality: daily ──────────────────────────────────────────────────────

document.getElementById("m-run").addEventListener("click", runMortDaily);
document.getElementById("m-day-select").addEventListener("change", runMortDaily);

async function runMortDaily() {
  const day = parseInt(document.getElementById("m-day-select").value);
  if (!day) { toast("Please select a day", "error"); return; }
  const btn = qs("#m-run");
  setLoading(btn, true);
  try {
    const r    = await fetch(`/api/mortality_day?day=${day}`);
    const data = await r.json();
    if (data.error) { toast("❌ " + data.error, "error"); return; }

    qs("#m-k-flock").textContent  = data.flock ?? "—";
    qs("#m-k-day").textContent    = `Day ${data.day}`;
    qs("#m-k-total").textContent  = data.total_morts ?? "—";
    qs("#m-k-avg").textContent    = data.avg_morts != null ? data.avg_morts.toFixed(1) : "—";
    qs("#m-k-houses").textContent = data.house_count ?? "—";
    show("m-kpis");

    const tbody = qs("#m-tbody");
    tbody.innerHTML = "";
    data.houses.forEach(h => {
      const pctFmt = h.pct_diff != null
        ? (h.pct_diff >= 0 ? `+${h.pct_diff.toFixed(1)}%` : `${h.pct_diff.toFixed(1)}%`) : "—";
      const pctCls = h.pct_diff && h.pct_diff > 20 ? "pct-red" : "pct-muted";
      const pillCls = h.status === "high" ? "pill pill-high" : "pill pill-ok";
      const pillTxt = h.status === "high" ? "⚠ High" : "✓ Normal";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="h-name">${h.house}</span></td>
        <td>${h.morts}</td>
        <td>${h.avg_morts != null ? h.avg_morts : "—"}</td>
        <td><span class="pct ${pctCls}">${pctFmt}</span></td>
        <td><span class="${pillCls}">${pillTxt}</span></td>`;
      tbody.appendChild(tr);
    });
    show("m-table-panel");
  } finally {
    setLoading(btn, false, "Run Report");
  }
}

// ── Mortality: weekly ─────────────────────────────────────────────────────

document.getElementById("m-weekly-run").addEventListener("click", runMortWeekly);

async function runMortWeekly() {
  const btn = qs("#m-weekly-run");
  setLoading(btn, true, "Generating…");
  try {
    const r    = await fetch("/api/mortality_weekly");
    const data = await r.json();
    if (data.error) { toast("❌ " + data.error, "error"); return; }

    qs("#m-weekly-title").textContent = `Weekly Mortalities — Flock ${data.flock} (Day 0–${data.max_day})`;

    // Build header
    const thead = qs("#m-weekly-thead");
    thead.innerHTML = `<tr>
      <th>House</th>
      ${data.week_labels.map(w => `<th>${w}</th>`).join("")}
      <th>Total</th>
    </tr>`;

    // Build body
    const tbody = qs("#m-weekly-tbody");
    tbody.innerHTML = "";
    data.houses.forEach(h => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="h-name">${h.name}</span></td>
        ${h.weeks.map(w => `<td>${w}</td>`).join("")}
        <td><strong>${h.total}</strong></td>`;
      tbody.appendChild(tr);
    });
    show("m-weekly-panel");
  } finally {
    setLoading(btn, false, "Generate Weekly Report");
  }
}

// ── Mortality: cumulative ─────────────────────────────────────────────────

document.getElementById("m-cumul-run").addEventListener("click", runMortCumulative);

async function runMortCumulative() {
  const btn = qs("#m-cumul-run");
  setLoading(btn, true, "Generating…");
  try {
    const r    = await fetch("/api/mortality_cumulative");
    const data = await r.json();
    if (data.error) { toast("❌ " + data.error, "error"); return; }

    qs("#m-cumul-title").textContent = `Cumulative Mortality — Flock ${data.flock}`;

    // Totals chips
    const totalsEl = qs("#m-cumul-totals");
    totalsEl.innerHTML = data.houses
      .map(h => `<span class="total-chip"><strong>${h.house}</strong> ${h.total.toLocaleString()}</span>`)
      .join("");

    // Chart
    const ctx = qs("#m-cumul-chart").getContext("2d");
    if (cumulChart) { cumulChart.destroy(); cumulChart = null; }

    cumulChart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: data.houses.map((h, i) => ({
          label: h.house,
          data: h.points.map(p => ({x:p.day, y:p.value})),
          borderColor: CHART_COLORS[i % CHART_COLORS.length],
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: 0,
          tension: .3
        }))
      },
      options: chartOpts("Cumulative Morts")
    });
    show("m-cumul-panel");
  } finally {
    setLoading(btn, false, "Generate Cumulative Chart");
  }
}

// ── Shared chart options ──────────────────────────────────────────────────

function chartOpts(yLabel) {
  return {
    responsive: true,
    interaction: { mode:"index", intersect:false },
    plugins: {
      legend: { labels: { color:"#dde1ef", font:{ size:11 }, boxWidth:12 } },
      tooltip: {
        backgroundColor:"#13161f", borderColor:"#2a2f47", borderWidth:1,
        titleColor:"#dde1ef", bodyColor:"#6b7494"
      }
    },
    scales: {
      x: {
        type:"linear",
        title:{ display:true, text:"Day", color:"#6b7494" },
        grid:{ color:"rgba(42,47,71,.6)" },
        ticks:{ color:"#6b7494" }
      },
      y: {
        title:{ display:true, text:yLabel, color:"#6b7494" },
        grid:{ color:"rgba(42,47,71,.6)" },
        ticks:{ color:"#6b7494" }
      }
    }
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────

function qs(sel) { return document.querySelector(sel); }
function show(id) { document.getElementById(id).style.display = ""; }
function fmt(n) { return Number(n).toLocaleString(); }

function setLoading(btn, on, offLabel="Run Report") {
  btn.disabled = on;
  btn.innerHTML = on ? '<span class="spin"></span> Loading…' : offLabel;
}

function toast(msg, type="") {
  const el = qs("#toast");
  el.textContent = msg;
  el.className = "toast show " + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = "toast"; }, 3500);
}

// Drag-over highlight on upload drop zone
const dz = qs("#drop-zone");
if (dz) {
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.style.borderColor = "var(--accent)"; });
  dz.addEventListener("dragleave", () => { dz.style.borderColor = ""; });
  dz.addEventListener("drop", async e => {
    e.preventDefault(); dz.style.borderColor = "";
    const f = e.dataTransfer.files[0];
    if (f) await doUpload(f);
  });
}