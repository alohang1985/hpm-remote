/* HPM 리모컨 — Firebase RTDB REST API */

const RTDB_URL = "https://hpm-remote-default-rtdb.asia-southeast1.firebasedatabase.app";
const REMOTE_PASSCODE = "168402";

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

// ── 결과 대기 (polling) ──
async function waitResult(cmdId, timeoutMs = 120000) {
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
  return { status: "error", error: "시간 초과" };
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

// ── 날짜 초기화 + 체크인 변경 시 체크아웃 자동 +1일 ──
function initDates() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  $("checkin").value = today.toISOString().split("T")[0];
  $("checkout").value = tomorrow.toISOString().split("T")[0];

  // 체크인 변경 시 체크아웃 자동 업데이트
  $("checkin").addEventListener("change", () => updateCheckout());

  // 박수 버튼
  let selectedNights = 1;
  document.querySelectorAll(".btn-night").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-night").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      selectedNights = parseInt(btn.dataset.nights);
      updateCheckout();
    });
  });

  function updateCheckout() {
    const ci = new Date($("checkin").value);
    ci.setDate(ci.getDate() + selectedNights);
    $("checkout").value = ci.toISOString().split("T")[0];
  }
}

// ── 방 이름에서 기본 이름 추출 (프로모션/옵션 제거) ──
function baseRoomName(name) {
  // "가든 풀 스윗&투어픽라운지 (일반)" → "가든 풀 스윗&투어픽라운지"
  // "디럭스 룸 (얼리버드 30일 오퍼)" → "디럭스 룸"
  return (name || "").replace(/\s*\(.*\)\s*$/, "").trim();
}

function vendorLabel(vid) {
  if (vid.includes("tourpik") || vid.includes("tp")) return "투어픽";
  if (vid.includes("peak")) return "피크타임";
  if (vid.includes("ghost")) return "고스트";
  return vid;
}

// ── 크롤링 결과 렌더링 (방 이름 그룹핑) ──
function renderCrawlResult(data) {
  if (!data || !data.rows) {
    showResult("결과", '<p style="color:#999">데이터 없음</p>');
    return;
  }

  const rows = Array.isArray(data.rows) ? data.rows : Object.values(data.rows);

  // 방 이름 기본 부분으로 그룹핑 + 벤더별 최저가만 수집
  const grouped = {};
  rows.forEach((row) => {
    const fullName = row.roomName || row.name || "—";
    const base = baseRoomName(fullName);
    if (!grouped[base]) grouped[base] = {};

    const vp = row.vendorPrices || {};
    for (const [vid, v] of Object.entries(vp)) {
      const price = v.priceNumeric || 0;
      if (price <= 0) continue;
      // 벤더별 최저가 유지
      if (!grouped[base][vid] || price < grouped[base][vid].price) {
        grouped[base][vid] = { price, priceText: v.priceText || "", detail: fullName };
      }
    }
  });

  let html = '<div class="scroll-area">';
  const roomNames = Object.keys(grouped);

  roomNames.forEach((base) => {
    const vendors = grouped[base];
    const vendorEntries = Object.entries(vendors);
    if (!vendorEntries.length) return;

    // 최저가 찾기
    let minPrice = Infinity;
    vendorEntries.forEach(([, v]) => { if (v.price < minPrice) minPrice = v.price; });

    html += `<div class="room-card">
      <div class="room-name">${base}</div>
      <div class="room-prices">`;

    vendorEntries.forEach(([vid, v]) => {
      const priceStr = v.price.toLocaleString() + "원";
      const isMin = v.price === minPrice;
      const diff = v.price !== minPrice
        ? `+${(v.price - minPrice).toLocaleString()}`
        : "";
      const diffClass = diff ? "price-diff-up" : "";

      html += `<div class="room-price-row">
        <span class="vendor-label">${vendorLabel(vid)}</span>
        <span class="vendor-price ${isMin ? "price-tp" : ""}">${priceStr}</span>
        <span class="vendor-diff ${diffClass}">${diff}</span>
      </div>`;
    });

    html += `</div></div>`;
  });

  html += "</div>";

  const vendorSummary = data.vendors
    ? Object.entries(data.vendors).map(([k, v]) =>
        `${v.vendorName || k}: ${v.success ? "✅" : "❌ " + (v.error || "")}`
      ).join(" · ")
    : "";

  showResult(
    `📊 ${data.hotelName || "결과"} (${roomNames.length}개 룸)`,
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

// ── 마크업 점검 ──
let __currentMarkupHotelId = null;

$("btn-markup").addEventListener("click", async () => {
  const hotel = getSelectedHotel();
  if (!hotel) { showStatus("호텔을 선택해주세요", "error"); return; }

  const btn = $("btn-markup");
  btn.disabled = true;
  btn.textContent = "⏳ 마크업 로딩 중...";
  showStatus(`<span class="spinner"></span> ${hotel.name} 마크업 페이지 로딩 중...`, "");
  $("adjust-area").style.display = "none";
  hideResult();

  try {
    const cmdId = await sendCommand("markupFetch", { hotelId: hotel.id });
    const result = await waitResult(cmdId);

    if (result.status === "done" && result.data && result.data.rows) {
      const d = result.data;
      __currentMarkupHotelId = hotel.id;
      showStatus("✅ 마크업 데이터 수집 완료!", "success");

      // 요약 표시
      const minColor = d.minProfit < 0 ? "#ef4444" : "#10b981";
      $("adjust-summary").innerHTML = `
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">${d.hotelName}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <span>평균: <b style="color:#f59e0b">${d.avgProfit.toLocaleString()}원</b> (${d.avgPct}%)</span>
          <span>최소: <b style="color:${minColor}">${d.minProfit.toLocaleString()}원</b></span>
          <span>최대: <b style="color:#10b981">${d.maxProfit.toLocaleString()}원</b></span>
        </div>
        <div style="color:#707070;font-size:11px;margin-top:4px;">${d.count}개 항목 · 환율 ${d.rate}</div>
      `;
      $("adjust-area").style.display = "block";
      $("adjust-preview").style.display = "none";
      $("btn-adjust-run").style.display = "none";
    } else {
      showStatus(`❌ ${result.data?.error || result.error || "마크업 데이터 수집 실패"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
  btn.textContent = "💰 마크업 점검";
});

// ── 프리셋 버튼 ──
document.querySelectorAll(".btn-preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("adjust-mode").value = btn.dataset.mode;
    $("adjust-target").value = btn.dataset.val;
    $("adjust-target").step = btn.dataset.mode === "pct" ? "0.1" : "100";
  });
});

// ── 미리보기 ──
$("btn-adjust-preview").addEventListener("click", async () => {
  if (!__currentMarkupHotelId) { showStatus("먼저 마크업 점검을 해주세요", "error"); return; }

  const mode = $("adjust-mode").value;
  const value = parseFloat($("adjust-target").value) || 0;
  const btn = $("btn-adjust-preview");
  btn.disabled = true;
  showStatus(`<span class="spinner"></span> 미리보기 계산 중...`, "");

  try {
    const cmdId = await sendCommand("bulkAdjust", {
      hotelId: __currentMarkupHotelId, mode, value, preview: true
    });
    const result = await waitResult(cmdId, 30000);

    if (result.status === "done" && result.data && result.data.preview) {
      const d = result.data;
      const diff = d.totalAfter - d.totalBefore;
      const diffSign = diff >= 0 ? "+" : "";

      let html = `<div style="font-size:12px;color:#a0a0a0;margin-bottom:6px;">
        총수익: ${d.totalBefore.toLocaleString()}원 → <b style="color:${diff >= 0 ? "#10b981" : "#ef4444"}">${d.totalAfter.toLocaleString()}원</b> (${diffSign}${diff.toLocaleString()}원) · ${d.totalChanged}개 변경
      </div>`;

      if (d.preview.length) {
        html += '<div style="max-height:200px;overflow-y:auto;"><table class="adjust-table"><thead><tr><th>룸</th><th>현SALE</th><th>신SALE</th><th>수익₩</th></tr></thead><tbody>';
        d.preview.forEach(r => {
          const cls = r.newProfit < 0 ? "neg" : "pos";
          html += `<tr>
            <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.roomName}">${r.roomName || "-"}</td>
            <td>${r.sale.toLocaleString()}</td>
            <td><b>${r.newSale.toLocaleString()}</b></td>
            <td class="${cls}">${r.newProfit.toLocaleString()}</td>
          </tr>`;
        });
        html += '</tbody></table></div>';
      }

      $("adjust-preview").innerHTML = html;
      $("adjust-preview").style.display = "block";
      $("btn-adjust-run").style.display = "block";
      showStatus(`📋 ${d.totalChanged}개 변경 예정`, "");
    } else {
      showStatus(`❌ ${result.data?.error || result.error || "미리보기 실패"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
});

// ── 실행 (저장) ──
$("btn-adjust-run").addEventListener("click", async () => {
  if (!__currentMarkupHotelId) return;
  if (!confirm("정말 실행하시겠습니까? SALE 값이 변경되고 저장됩니다.")) return;

  const mode = $("adjust-mode").value;
  const value = parseFloat($("adjust-target").value) || 0;
  const btn = $("btn-adjust-run");
  btn.disabled = true;
  btn.textContent = "⏳ 저장 중...";
  showStatus(`<span class="spinner"></span> SALE 값 변경 + 저장 중...`, "");

  try {
    const cmdId = await sendCommand("bulkAdjust", {
      hotelId: __currentMarkupHotelId, mode, value, preview: false
    });
    const result = await waitResult(cmdId);

    if (result.status === "done" && result.data) {
      if (result.data.changed > 0) {
        showStatus(`✅ ${result.data.changed}개 변경 완료! ${result.data.message || ""}`, "success");
      } else {
        showStatus("변경 사항 없음", "");
      }
    } else {
      showStatus(`❌ ${result.data?.error || result.error || "실행 실패"}`, "error");
    }
  } catch (e) {
    showStatus(`❌ 오류: ${e.message}`, "error");
  }

  btn.disabled = false;
  btn.textContent = "🚀 실행 (저장)";
});

// ── 잠금 화면 ──
function checkLock() {
  const saved = sessionStorage.getItem("hpm_remote_unlocked");
  if (saved === "true") {
    unlock();
    return;
  }
  $("lock-screen").style.display = "flex";
  $("main-app").style.display = "none";
}

function unlock() {
  sessionStorage.setItem("hpm_remote_unlocked", "true");
  $("lock-screen").style.display = "none";
  $("main-app").style.display = "block";
  initApp();
}

$("lock-btn").addEventListener("click", () => {
  const input = $("lock-input").value;
  if (input === REMOTE_PASSCODE) {
    unlock();
  } else {
    $("lock-msg").textContent = "비밀번호가 틀렸습니다";
    $("lock-input").value = "";
    $("lock-input").focus();
  }
});

$("lock-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("lock-btn").click();
});

// ── 명령에 인증키 포함 ──
async function sendCommand(action, params = {}) {
  const cmdId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await rtdbPut(`commands/${cmdId}`, {
    action,
    params,
    authKey: REMOTE_PASSCODE,
    status: "pending",
    timestamp: Date.now()
  });
  return cmdId;
}

// ── 초기화 ──
async function initApp() {
  initDates();
  await checkPcStatus();
  await loadHotels();
  setInterval(checkPcStatus, 5000);
}

// 시작
checkLock();
