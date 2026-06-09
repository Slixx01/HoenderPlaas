/* ── Poultry Dashboard – Frontend JS ── */

let trendChart = null;
let currentTab = "weight";
let currentTrendData = null;
let availableDays = [];

// ── File upload handling ───────────────────────────────────────────────────

function setupUpload(inputId) {
  document.getElementById(inputId).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await uploadFile(file);
    e.target.value = "";
  });
}

setupUpload("file-input");
setupUpload("file-input-center");

async function uploadFile(file) {
  showToast("⏳ Loading workbook…");

  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: form });
    const data = await res.json();

    if (data.error) { showToast("❌ " + data.error, "error"); return; }

    // Hide overlay, show main
    document.getElementById("upload-overlay").style.display = "none";
    document.getElementById("main-content").style.display = "block";

    document.getElementById("loaded-file").textContent =
      `📂 ${data.filename}  ·  ${data.flocks.length} flocks  ·  ${data.weight_records} weight records  ·  ${data.morts_records} mort records`;

    availableDays = data.available_days;
    populateDaySelect(availableDays);
    renderFlockCards(data.flocks);

    showToast(`✅ Loaded ${data.filename}`, "success");
  } catch (err) {
    showToast("❌ Upload failed: " + err.message, "error");
  }
}

function populateDaySelect(days) {
  const sel = document.getElementById("day-select");
  sel.innerHTML = '<option value="">-- choose day --</option>';
  days.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = `Day ${d}`;
    sel.appendChild(opt);
  });
  // Default to last available day
  if (days.length) sel.value = days[days.length - 1];
}

// ── Query execution ───────────────────────────────────────────────────────

document.getElementById("run-query").addEventListener("click", runQuery);
document.getElementById("day-select").addEventListener("change", runQuery);

async function runQuery() {
  const day = parseInt(document.getElementById("day-select").value);
  const threshold = parseFloat(document.getElementById("threshold-input").value) || 5;

  if (!day) { showToast("Please select a day", "error"); return; }

  const btn = document.getElementById("run-query");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running…';

  try {
    const res = await fetch(`/api/query_day?day=${day}&threshold=${threshold}`);
    const data = await res.json();

    if (data.error) { showToast("❌ " + data.error, "error"); return; }

    renderSummaryCards(data);
    renderResultsTable(data, threshold);

    document.getElementById("summary-cards").style.display = "grid";
    document.getElementById("results-section").style.display = "block";
  } catch (err) {
    showToast("❌ Query failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Run Report";
  }
}

// ── Render summary cards ──────────────────────────────────────────────────

function renderSummaryCards(data) {
  document.getElementById("card-flock").textContent = data.flock ?? "—";
  document.getElementById("card-day").textContent = `Day ${data.day}`;
  document.getElementById("card-avg").textContent =
    data.three_cycle_avg != null ? data.three_cycle_avg.toLocaleString() : "—";
  document.getElementById("card-below").textContent = data.below_avg_count;
  document.getElementById("card-above").textContent = data.above_avg_count;
}

// ── Render results table ──────────────────────────────────────────────────

function renderResultsTable(data, threshold) {
  const tbody = document.getElementById("results-body");
  tbody.innerHTML = "";

  const sorted = [...data.houses].sort((a, b) => {
    // Sort: below first (worst), then ok, then above
    const order = { below: 0, ok: 1, above: 2 };
    return order[a.status] - order[b.status];
  });

  sorted.forEach(h => {
    const tr = document.createElement("tr");
    tr.dataset.house = h.house;

    const diff = h.weight != null && h.avg_weight != null
      ? (h.weight - h.avg_weight).toFixed(1)
      : "—";
    const diffNum = parseFloat(diff);
    const diffStr = isNaN(diffNum) ? "—"
      : (diffNum >= 0 ? `+${diffNum}` : `${diffNum}`);

    const pctStr = h.pct_diff != null
      ? (h.pct_diff >= 0 ? `+${h.pct_diff.toFixed(1)}%` : `${h.pct_diff.toFixed(1)}%`)
      : "—";
    const pctClass = h.status === "below" ? "pct-below"
                   : h.status === "above" ? "pct-above" : "pct-ok";

    const statusLabel = h.status === "below" ? "⬇ Under"
                      : h.status === "above" ? "⬆ Over" : "✓ On Track";
    const statusClass = `status-${h.status}`;

    tr.innerHTML = `
      <td><span class="house-name">${h.house}</span></td>
      <td>${h.weight != null ? h.weight.toLocaleString() : "—"}</td>
      <td>${h.avg_weight != null ? h.avg_weight.toLocaleString() : "—"}</td>
      <td>${diffStr}</td>
      <td><span class="pct-value ${pctClass}">${pctStr}</span></td>
      <td>${h.morts != null ? h.morts : "—"}</td>
      <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
    `;

    tr.addEventListener("click", () => loadHouseTrend(h.house, tr));
    tbody.appendChild(tr);
  });
}

// ── House trend chart ─────────────────────────────────────────────────────

async function loadHouseTrend(house, rowEl) {
  // Highlight row
  document.querySelectorAll("#results-body tr").forEach(r => r.classList.remove("selected"));
  rowEl.classList.add("selected");

  try {
    const res = await fetch(`/api/house_trend?house=${house}`);
    currentTrendData = await res.json();

    document.getElementById("chart-title").textContent =
      `House ${house}  —  Flock ${currentTrendData.flock}  (click row to compare)`;

    document.getElementById("chart-section").style.display = "block";
    document.getElementById("chart-section").scrollIntoView({ behavior: "smooth", block: "nearest" });

    renderChart(currentTab);
  } catch (err) {
    showToast("❌ Could not load trend: " + err.message, "error");
  }
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    if (currentTrendData) renderChart(currentTab);
  });
});

document.getElementById("close-chart").addEventListener("click", () => {
  document.getElementById("chart-section").style.display = "none";
  document.querySelectorAll("#results-body tr").forEach(r => r.classList.remove("selected"));
  currentTrendData = null;
  if (trendChart) { trendChart.destroy(); trendChart = null; }
});

function renderChart(tab) {
  const ctx = document.getElementById("trend-chart").getContext("2d");
  if (trendChart) { trendChart.destroy(); trendChart = null; }

  let datasets = [];
  let yLabel = "";

  if (tab === "weight") {
    yLabel = "Weight (g)";
    datasets = [
      {
        label: `${currentTrendData.house} Weight`,
        data: currentTrendData.weight.map(p => ({ x: p.day, y: p.value })),
        borderColor: "#4f8ef7",
        backgroundColor: "rgba(79,142,247,.1)",
        borderWidth: 2.5,
        pointRadius: 3,
        tension: 0.3,
        fill: true,
      },
      {
        label: "3-Cycle Avg",
        data: currentTrendData.avg.map(p => ({ x: p.day, y: p.value })),
        borderColor: "#f39c12",
        backgroundColor: "transparent",
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        tension: 0.3,
      }
    ];
  } else {
    yLabel = "Daily Mortalities";
    datasets = [
      {
        label: `${currentTrendData.house} Morts`,
        data: currentTrendData.morts.map(p => ({ x: p.day, y: p.value })),
        borderColor: "#e74c3c",
        backgroundColor: "rgba(231,76,60,.15)",
        borderWidth: 2.5,
        pointRadius: 3,
        tension: 0.3,
        fill: true,
      }
    ];
  }

  trendChart = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e8eaf0", font: { size: 12 } } },
        tooltip: {
          backgroundColor: "#1a1d27",
          borderColor: "#2d3250",
          borderWidth: 1,
          titleColor: "#e8eaf0",
          bodyColor: "#7a82a0",
        }
      },
      scales: {
        x: {
          type: "linear",
          title: { display: true, text: "Day", color: "#7a82a0" },
          grid: { color: "rgba(45,50,80,.5)" },
          ticks: { color: "#7a82a0" }
        },
        y: {
          title: { display: true, text: yLabel, color: "#7a82a0" },
          grid: { color: "rgba(45,50,80,.5)" },
          ticks: { color: "#7a82a0" }
        }
      }
    }
  });
}

// ── Flock cards ───────────────────────────────────────────────────────────

function renderFlockCards(flocks) {
  const container = document.getElementById("flock-cards");
  container.innerHTML = "";
  const maxFlock = Math.max(...flocks.map(f => f.flock));

  flocks.forEach(f => {
    const card = document.createElement("div");
    card.className = "flock-card" + (f.flock === maxFlock ? " current" : "");
    card.innerHTML = `
      <div class="flock-num">Flock ${f.flock}</div>
      <div class="flock-meta">Max day recorded: <strong>${f.max_day}</strong></div>
      ${f.flock === maxFlock ? '<span class="current-badge">CURRENT</span>' : ''}
    `;
    card.addEventListener("click", () => {
      // Select last day for this flock and run
      fetch(`/api/available_days`).then(r => r.json()).then(d => {
        availableDays = d.days;
        populateDaySelect(availableDays);
        runQuery();
      });
    });
    container.appendChild(card);
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────

function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show " + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = "toast"; }, 3500);
}

// ── Row selected style ────────────────────────────────────────────────────

const rowStyle = document.createElement("style");
rowStyle.textContent = `
  #results-body tr.selected { background: rgba(79,142,247,.12) !important; }
`;
document.head.appendChild(rowStyle);
