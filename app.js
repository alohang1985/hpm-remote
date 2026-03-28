/* HPM 리모컨 — Firebase RTDB REST API */

const RTDB_URL = "https://hpm-remote-default-rtdb.asia-southeast1.firebasedatabase.app";

// ── Firebase REST 헬퍼 ──
async function rtdbGet(path) {
  const r = await fetch(`${RTDB_URL}/${path}.json`);
  return r.ok ? r.json() : null;
}
async function rtdbPut(path, data) {
  await fetch(`${RTDB_URL}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

// ── 명령 전송 ──
async function sendCommand(action, params = {}) {
  const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await rtdbPut(`commands/${cmdId}`, {
    action,
    params,
    status: "pending",
    timestamp: Date.now()
  });
  return cmdId;
}

// ── 결과 대기 (polling) ──
async function waitResult(cmdId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await rtdbGet(`results/${cmdId}`);
    if (result && (result.status === "done" || result.status === "error")) {
      return result;
    }
    // 진행 상태 표시
    if (result && result.status === "crawling") {
      showStatus(`<span class="spinner"></span> ${result.message || "크롤링 중..."}`, "");
    }
    await sleep(1500);
  }
  return { status: "error", error: "시간 초과 (60초)" };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── UI 헬퍼 ──
const $ = (id) => document.getElementById(id);
function showStatus(msg, cls = "") {
  const area = $("status-area");
  const el = $("status-msg");
  area.style.display = "block";
  el.className = `status-msg ${cls}`;
  el.innerHTML = msg;
}
function hideStatus() {
  $("status-area").style.display = "none";
}
function showResult(title, html) {
  const area = $("result-area");
  $("result-title").textContent = title;
  $("result-content").innerHTML = html;
  area.style.display = "block";
}
function hideResult() {
  $("result-area").style.display = "none";
}

// ── PC 상태 모니터링 ──
async function checkPcStatus() {
  try {
    const status = await rtdbGet("status/pc");
    const el = $("pc-status");
    if (status && status.online && (Date.now() - status.lastSeen < 60000)) {
      el.className = "status online";
      el.textContent = "🟢 PC 연결됨";
      if (status.currentTask) {
        el.textContent += ` (${status.currentTask})`;
      }
    } else {
      el.className = "status offline";
      el.textContent = "🔴 PC 오프라인";
    }
  } catch (_) {
    $("pc-status").className = "status offline";
    $("pc-status").textContent = "🔴 연결 실패";
  }
}

// ── 호텔 목록 로드 ──
async function loadHotels() {
  const hotels = await rtdbGet("hotelList");
  const sel = $("hotel-select");
  sel.innerHTML = "";

  if (!hotels || !hotels.length) {
    sel.innerHTML = '<option value="">호텔 없음 — PC에서 동기화 필요</option>';
    return;
  }

  hotels.forEach((h, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `${h.name} (${h.vendors?.length || 0}개 벤더)`;
    sel.appendChild(opt);
  });

  // 호텔 데이터 전역 저장
  window.__hotels = hotels;
}

function getSelectedHotel() {
  const idx = parseInt($("hotel-select").value);
  return window.__hotels?.[idx] || null;
}

// ── 날짜 초기화 ──
function initDates() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  $("checkin").value = today.toISOString().split("T")[0];
  $("checkout").value = tomorrow.toISOString().split("T")[0];
}

// ── 크롤링 결과 렌더링 ──
function renderCrawlResult(data) {
  if (!data || !data.rows) {
    showResult("결과", '<p style="color:#999">데이터 없음</p>');
    return;
  }

  const rows = Array.isArray(data.rows) ? data.rows : Object.values(data.rows);
  let html = '<div class="scroll-area">';

  rows.forEach((row) => {
    const name = row.roomName || row.name || "—";
    const vp = row.vendorPrices || {};
    html += `<div class="room-card">
      <div class="room-name">${name}</div>
      <div class="room-prices">`;

    // 최저가 찾기
    let minPrice = Infinity;
    Object.values(vp).forEach((v) => {
      const p = v.priceNumeric || 0;
      if (p > 0 && p < minPrice) minPrice = p;
    });

    for (const [vid, v] of Object.entries(vp)) {
      const price = v.priceNumeric || 0;
      const priceStr = price > 0 ? price.toLocaleString() + "원" : "—";
      const isMin = price === minPrice && price > 0;
      const diff = price > 0 && minPrice < Infinity && price !== minPrice
        ? ((price - minPrice) > 0 ? `+${(price - minPrice).toLocaleString()}` : (price - minPrice).toLocaleString())
        : "";
      const diffClass = diff.startsWith("+") ? "price-diff-up" : "price-diff-down";

      let label = vid;
      if (vid.includes("tourpik") || vid.includes("tp")) label = "투어픽";
      else if (vid.includes("peak")) label = "피크타임";
      else if (vid.includes("ghost")) label = "고스트";

      html += `<div class="room-price-row">
        <span class="vendor-label">${label}</span>
        <span class="vendor-price ${isMin ? "price-tp" : ""}">${priceStr}</span>
        <span class="vendor-diff ${diffClass}">${diff}</span>
      </div>`;
    }

    html += `</div></div>`;
  });

  html += "</div>";

  const vendorSummary = data.vendors
    ? Object.entries(data.vendors).map(([k, v]) =>
        `${v.vendorName || k}: ${v.success ? "✅" : "❌ " + (v.error || "")}`
      ).join(" · ")
    : "";

  showResult(
    `📊 ${data.hotelName || "크롤링 결과"} (${rows.length}개 룸)`,
    (vendorSummary ? `<p style="font-size:11px;color:#999;margin-bottom:8px">${vendorSummary}</p>` : "") + html
  );
}

// ── 이벤트 핸들러 ──
$("btn-crawl").addEventListener("click", async () => {
  const hotel = getSelectedHotel();
  if (!hotel) { showStatus("호텔을 선택해주세요", "error"); return; }

  const btn = $("btn-crawl");
  btn.disabled = true;
  btn.textContent = "🔄 크롤링 중...";
  showStatus(`<span class="spinner"></span> ${hotel.name} 크롤링 요청 중...`, "");
  hideResult();

  try {
    const cmdId = await sendCommand("crawl", {
      hotelId: hotel.id,
      dateInfo: {
        checkIn: $("checkin").value,
        checkOut: $("checkout").value
      }
    });

    const result = await waitResult(cmdId);

    if (result.status === "done" && result.data) {
      if (result.data.error) {
        showStatus(`❌ ${result.data.error}${result.data.message ? ": " + result.data.message : ""}`, "error");
      } else {
        showStatus("✅ 크롤링 완료!", "success");
        renderCrawlResult(result.data);
      }
    } else {
      showStatus(`❌ ${result.error || "알 수 없는 오류"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
  btn.textContent = "🔍 크롤링";
});

$("btn-latest").addEventListener("click", async () => {
  const hotel = getSelectedHotel();
  if (!hotel) { showStatus("호텔을 선택해주세요", "error"); return; }

  const btn = $("btn-latest");
  btn.disabled = true;
  showStatus(`<span class="spinner"></span> ${hotel.name} 최신 데이터 조회 중...`, "");

  try {
    const cmdId = await sendCommand("getLatest", { hotelId: hotel.id });
    const result = await waitResult(cmdId, 15000);

    if (result.status === "done" && result.data) {
      if (result.data.error) {
        showStatus("데이터가 없습니다. 크롤링을 먼저 해주세요.", "error");
      } else {
        showStatus("✅ 조회 완료!", "success");
        renderCrawlResult(result.data);
      }
    } else {
      showStatus(`❌ ${result.error || "조회 실패"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
});

$("btn-sync").addEventListener("click", async () => {
  const btn = $("btn-sync");
  btn.disabled = true;
  showStatus(`<span class="spinner"></span> 호텔 목록 동기화 중...`, "");

  try {
    const cmdId = await sendCommand("syncHotels");
    const result = await waitResult(cmdId, 10000);

    if (result.status === "done") {
      showStatus("✅ 동기화 완료!", "success");
      await loadHotels();
    } else {
      showStatus(`❌ ${result.error || "동기화 실패"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
});

// ── 초기화 ──
async function init() {
  initDates();
  await checkPcStatus();
  await loadHotels();
  // 5초마다 PC 상태 확인
  setInterval(checkPcStatus, 5000);
}

init();
