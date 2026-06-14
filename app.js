import * as pdfjsLib from "./vendor/pdf.min.mjs";
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
const { createWorker } = Tesseract;
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

/* =========================================================
   우리 병원 결과지 템플릿 좌표 (페이지 비율, 항상 동일)
   값은 [nx0, ny0, nx1, ny1] (0~1, 좌상단 기준)
========================================================= */
const REGION = {
  rightTymp:  [0.041, 0.460, 0.486, 0.695],
  leftTymp:   [0.491, 0.460, 0.960, 0.695],
  header:     [0.360, 0.029, 0.965, 0.118],
  speech:     [0.038, 0.714, 0.965, 0.872],
  tinnito:    [0.038, 0.873, 0.965, 0.960],
};

// 평균 dB 숫자 위치(페이지 비율) — OCR + 확대 표시
const PTA_OCR = {
  right: [0.150, 0.1505, 0.207, 0.1596],
  left:  [0.826, 0.1495, 0.902, 0.1600],
};

// 좌우 동일 크기로 보이게 하는 오디오그램 표시 영역(그래프 박스 기준 정렬)
const AUDIO_DISPLAY = {
  right: [0.0342, 0.1401, 0.4403, 0.4477],
  left:  [0.4982, 0.1401, 0.9043, 0.4477],
};

// 오디오그램 축 보정(페이지 비율). 주파수=로그, dB=선형. 마커 위치 계산용.
const AUDIO_CAL = {
  right: { f1: 125, x1: 0.0842, f2: 8000, x2: 0.4175, d1: -10, y1: 0.1601, d2: 120, y2: 0.4167 },
  left:  { f1: 125, x1: 0.5482, f2: 8000, x2: 0.8663, d1: -10, y1: 0.1601, d2: 120, y2: 0.4060 },
};

// 이명표 셀(페이지 비율) — Rt/Lt 의 Pitch(Hz), Loudness(dB), 셀 테두리 안쪽
const TINNITO_CELLS = {
  right: { pitch: [0.2405, 0.900, 0.363, 0.917], loud: [0.3705, 0.900, 0.493, 0.917] },
  left:  { pitch: [0.2405, 0.921, 0.363, 0.937], loud: [0.3705, 0.921, 0.493, 0.937] },
};

const RENDER_SCALE = 3.2;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const dropScreen = $("dropScreen");
const resultScreen = $("resultScreen");
const loading = $("loading");
const dropZone = $("dropZone");
const fileInput = $("fileInput");
const dropError = $("dropError");

let ocrWorker = null;

/* ---------- 드래그앤드롭 ---------- */
$("pickBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});
$("resetBtn").addEventListener("click", () => {
  resultScreen.hidden = true;
  dropScreen.hidden = false;
  dropError.hidden = true;
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); })
);
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
dropZone.addEventListener("click", () => fileInput.click());

/* ---------- OCR 준비 ---------- */
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker("eng", 1, {
    workerPath: new URL("./vendor/tesseract/worker.min.js", import.meta.url).href,
    corePath: new URL("./vendor/tesseract/core/", import.meta.url).href,
    langPath: new URL("./vendor/tesseract/lang/", import.meta.url).href,
    gzip: true,
  });
  await ocrWorker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: "7", // 한 줄로 취급
  });
  return ocrWorker;
}

/* ---------- 메인 처리 ---------- */
async function handleFile(file) {
  dropError.hidden = true;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("PDF 파일만 올릴 수 있어요.");
    return;
  }
  dropScreen.hidden = true;
  loading.hidden = false;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = viewport.width;
    pageCanvas.height = viewport.height;
    await page.render({ canvasContext: pageCanvas.getContext("2d"), viewport }).promise;

    await renderStatic(pageCanvas);   // 그래프/표 등 즉시 표시
    loading.hidden = true;
    resultScreen.hidden = false;
    window.scrollTo(0, 0);

    await renderOcr(pageCanvas);      // 숫자 인식은 이어서(시간 걸림)
  } catch (err) {
    console.error(err);
    loading.hidden = true;
    dropScreen.hidden = false;
    showError("결과지를 읽지 못했어요. 우리 병원 검사 결과지 PDF가 맞는지 확인해 주세요.");
  }
}

function showError(msg) {
  dropError.textContent = msg;
  dropError.hidden = false;
}

/* ---------- 영역 잘라내기 ---------- */
function crop(src, [nx0, ny0, nx1, ny1]) {
  const sx = nx0 * src.width, sy = ny0 * src.height;
  const sw = (nx1 - nx0) * src.width, sh = (ny1 - ny0) * src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function cropMagnify(src, frac, zoom = 3) {
  const [fx0, fy0, fx1, fy1] = frac;
  const sx = fx0 * src.width, sy = fy0 * src.height;
  const sw = (fx1 - fx0) * src.width, sh = (fy1 - fy0) * src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw * zoom);
  c.height = Math.round(sh * zoom);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function placeCanvas(container, canvas) {
  container.querySelectorAll("canvas").forEach((n) => n.remove());
  container.prepend(canvas);
}

/* ---------- 즉시 표시되는 부분 ---------- */
async function renderStatic(pageCanvas) {
  // 환자 정보
  const meta = $("patientMeta");
  meta.innerHTML = "";
  meta.appendChild(crop(pageCanvas, REGION.header));

  // 좌우 동일 크기 오디오그램
  placeCanvas($("chartRight"), crop(pageCanvas, AUDIO_DISPLAY.right));
  placeCanvas($("chartLeft"), crop(pageCanvas, AUDIO_DISPLAY.left));

  // 평균 dB: 우선 확대 이미지로 채워두고, OCR 끝나면 깔끔한 글자로 교체
  $("ptaRight").innerHTML = "";
  $("ptaRight").appendChild(cropMagnify(pageCanvas, PTA_OCR.right));
  $("ptaLeft").innerHTML = "";
  $("ptaLeft").appendChild(cropMagnify(pageCanvas, PTA_OCR.left));

  // 임피던스 3분할
  placeCanvas($("tympRight"), crop(pageCanvas, REGION.rightTymp));
  placeCanvas($("tympLeft"), crop(pageCanvas, REGION.leftTymp));
  placeCanvas($("tympNormal"), drawNormalTympanogram());

  // 언어청력검사 결과 캡쳐
  placeCanvas($("speechCapture"), crop(pageCanvas, REGION.speech));
}

/* ---------- OCR 이후 표시 ---------- */
async function renderOcr(pageCanvas) {
  const worker = await getWorker();

  // 1) 평균 dB
  const rDb = await ocrNumber(worker, pageCanvas, PTA_OCR.right);
  const lDb = await ocrNumber(worker, pageCanvas, PTA_OCR.left);
  applyPta("right", rDb);
  applyPta("left", lDb);

  // 2) 이명표 OCR → 숫자 있는 쪽 찾기
  const tin = {};
  for (const side of ["right", "left"]) {
    const pitch = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].pitch);
    const loud = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].loud);
    tin[side] = { pitch, loud };
  }
  renderTinnitus(pageCanvas, tin);
}

/* 평균 dB 인식값 적용: 큰 글자 + 신호등 */
function applyPta(side, db) {
  const el = $(side === "right" ? "ptaRight" : "ptaLeft");
  const sig = $(side === "right" ? "sigRight" : "sigLeft");
  if (db == null) { sig.style.background = "#bbb"; return; } // 인식 실패 → 확대이미지 유지
  el.innerHTML = `${db} dB`;
  sig.style.background = signalColor(db);
}

/* 정도에 따른 신호등 색(주석 없음) */
function signalColor(db) {
  if (db <= 25) return "#2ecc40";  // 정상 - 초록
  if (db <= 40) return "#ffdf2b";  // 경도 - 노랑
  if (db <= 55) return "#ff9f1a";  // 중등도 - 주황
  if (db <= 70) return "#ff5a36";  // 중고도 - 진주황
  if (db <= 90) return "#e02424";  // 고도 - 빨강
  return "#8e0000";                // 심도 - 진빨강
}

/* ---------- OCR 숫자 인식 ---------- */
async function ocrNumber(worker, src, region) {
  const pre = preprocess(src, region);
  if (pre.inkRatio < 0.004) return null; // 거의 빈칸
  const { data } = await worker.recognize(pre.canvas);
  const digits = (data.text || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// 셀을 확대 + 회색조 + 흰 여백 추가(작은 글자 인식률 향상), 잉크 비율도 계산
function preprocess(src, [nx0, ny0, nx1, ny1], zoom = 4, pad = 30) {
  const sx = nx0 * src.width, sy = ny0 * src.height;
  const sw = (nx1 - nx0) * src.width, sh = (ny1 - ny0) * src.height;
  const dw = Math.round(sw * zoom), dh = Math.round(sh * zoom);
  const c = document.createElement("canvas");
  c.width = dw + pad * 2;
  c.height = dh + pad * 2;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, pad, pad, dw, dh);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (g < 130) ink++;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, inkRatio: ink / (c.width * c.height) };
}

/* ---------- 이명검사 표시 ---------- */
function renderTinnitus(pageCanvas, tin) {
  const grid = $("tinnitusGrid");
  grid.innerHTML = "";

  // 숫자(피치)가 있는 쪽 = 이명이 있는 쪽
  const sides = ["right", "left"].filter((s) => tin[s].pitch != null);

  if (sides.length === 0) {
    const note = document.createElement("div");
    note.className = "tin-note";
    note.textContent = "이명검사에 기록된 수치가 없습니다. 아래 표를 참고하세요.";
    grid.appendChild(note);
  }

  for (const side of sides) {
    const { pitch, loud } = tin[side];
    grid.appendChild(buildTinnitusAudiogram(pageCanvas, side, pitch, loud));
  }

  // 이명표 원본 캡쳐
  const tableCard = document.createElement("article");
  tableCard.className = "capture-card";
  tableCard.appendChild(crop(pageCanvas, REGION.tinnito));
  grid.appendChild(tableCard);
}

function buildTinnitusAudiogram(pageCanvas, side, pitch, loud) {
  const kr = side === "right" ? "오른쪽" : "왼쪽";
  const en = side === "right" ? "RIGHT" : "LEFT";
  const bannerColor = side === "right" ? "var(--red)" : "var(--blue)";

  const panel = document.createElement("article");
  panel.className = "panel";

  const head = document.createElement("div");
  head.className = "tin-head";
  head.style.background = bannerColor;
  head.innerHTML = `<span class="ear-label">${kr}</span><span class="ear-en">${en} · 이명 위치 표시</span>`;
  panel.appendChild(head);

  const wrap = document.createElement("div");
  wrap.className = "chart-wrap";
  wrap.appendChild(crop(pageCanvas, AUDIO_DISPLAY[side]));

  // 마커 위치(표시 영역 내부 비율)
  if (pitch != null && loud != null) {
    const { fx, fy } = markerFrac(side, pitch, loud);
    const marker = document.createElement("span");
    marker.className = "tin-marker";
    marker.style.left = `calc(10px + ${fx} * (100% - 20px))`;
    marker.style.top = `calc(10px + ${fy} * (100% - 20px))`;
    wrap.appendChild(marker);

    const callout = document.createElement("span");
    callout.className = "tin-callout";
    callout.textContent = `이명 ${pitch}Hz · ${loud}dB`;
    callout.style.left = `calc(10px + ${fx} * (100% - 20px))`;
    callout.style.top = `calc(10px + ${fy} * (100% - 20px) - 34px)`;
    wrap.appendChild(callout);
  }
  panel.appendChild(wrap);
  return panel;
}

// (주파수 Hz, 강도 dB) → 표시 영역 내부 비율
function markerFrac(side, hz, db) {
  const c = AUDIO_CAL[side];
  const disp = AUDIO_DISPLAY[side];
  const pageX = c.x1 + (Math.log10(hz / c.f1) / Math.log10(c.f2 / c.f1)) * (c.x2 - c.x1);
  const pageY = c.y1 + ((db - c.d1) / (c.d2 - c.d1)) * (c.y2 - c.y1);
  return {
    fx: (pageX - disp[0]) / (disp[2] - disp[0]),
    fy: (pageY - disp[1]) / (disp[3] - disp[1]),
  };
}

/* ---------- 정상 참고 고막운동성(Type A) 그래프 ---------- */
function drawNormalTympanogram() {
  const W = 480, H = 340;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  const m = { l: 46, r: 16, t: 14, b: 40 };
  const px = (daPa) => m.l + ((daPa + 600) / 900) * (W - m.l - m.r);
  const py = (ml) => H - m.b - (ml / 2) * (H - m.t - m.b);
  ctx.strokeStyle = "#bbb"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(m.l, py(0)); ctx.lineTo(W - m.r, py(0));
  ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, py(0));
  ctx.stroke();
  ctx.fillStyle = "#555"; ctx.font = "12px sans-serif";
  [-600, -300, 0, 300].forEach((v) => { ctx.textAlign = "center"; ctx.fillText(String(v), px(v), py(0) + 16); });
  [0, 1, 2].forEach((v) => { ctx.textAlign = "right"; ctx.fillText(String(v), m.l - 6, py(v) + 4); });
  ctx.textAlign = "left";
  ctx.fillText("ml", m.l - 2, m.t);
  ctx.fillText("daPa", W - m.r - 34, py(0) + 30);
  ctx.setLineDash([5, 4]); ctx.strokeStyle = "#999";
  ctx.strokeRect(px(-150), py(1.6), px(50) - px(-150), py(0.3) - py(1.6));
  ctx.setLineDash([]);
  ctx.strokeStyle = "#149646"; ctx.lineWidth = 3;
  ctx.beginPath();
  const mu = 0, sigma = 90, peak = 0.95, base = 0.08;
  for (let i = 0; i <= 180; i++) {
    const x = -600 + (i / 180) * 900;
    const y = base + peak * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
    const X = px(x), Y = py(y);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.stroke();
  ctx.fillStyle = "#149646";
  ctx.beginPath();
  ctx.moveTo(px(0), py(1.03) - 2);
  ctx.lineTo(px(0) - 7, py(1.03) - 14);
  ctx.lineTo(px(0) + 7, py(1.03) - 14);
  ctx.closePath(); ctx.fill();
  return c;
}
