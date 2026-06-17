import * as pdfjsLib from "./vendor/pdf.min.mjs";
import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
const { createWorker } = Tesseract;
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

/* =========================================================
   우리 병원 결과지 템플릿 좌표 (페이지 비율, 항상 동일)
========================================================= */
const REGION = {
  header:    [0.360, 0.029, 0.965, 0.118],
  speech:    [0.038, 0.714, 0.965, 0.872],
  tinnito:   [0.038, 0.873, 0.965, 0.960],
};

// 평균 dB 숫자 위치(페이지 비율)
// 왼쪽 박스는 세 자리 수(100 이상)의 백의 자리가 잘리지 않도록 왼쪽으로 더 넓힘
const PTA_OCR = {
  right: [0.150, 0.1505, 0.207, 0.1596],
  left:  [0.818, 0.1495, 0.902, 0.1600],
};

// 좌우 동일 크기 오디오그램 표시 영역
const AUDIO_DISPLAY = {
  right: [0.0342, 0.1401, 0.4403, 0.4477],
  left:  [0.4982, 0.1401, 0.9043, 0.4477],
};

// 좌우 동일 크기 임피던스 표시 영역
const TYMP_DISPLAY = {
  right: [0.0427, 0.462, 0.4852, 0.697],
  left:  [0.4927, 0.462, 0.9352, 0.697],
};

// 오디오그램 축 보정(페이지 비율). 주파수=로그, dB=선형.
const AUDIO_CAL = {
  right: { f1: 125, x1: 0.0842, f2: 8000, x2: 0.4175, d1: -10, y1: 0.1601, d2: 120, y2: 0.4167, bL: 0.0842, bR: 0.4235 },
  left:  { f1: 125, x1: 0.5482, f2: 8000, x2: 0.8663, d1: -10, y1: 0.1601, d2: 120, y2: 0.4060, bL: 0.5482, bR: 0.8761 },
};

// 이명표 셀(페이지 비율) — Rt/Lt 의 Pitch(Hz), Loudness(dB)
// 칸 경계선(세로선)이 "1"로 오인식되던 문제 때문에, 박스를 넉넉히 잡고
// 전처리(removeTableLines)에서 표의 칸 선을 지워 숫자만 남도록 한다.
const TINNITO_CELLS = {
  right: { pitch: [0.244, 0.899, 0.364, 0.919], loud: [0.372, 0.899, 0.493, 0.919] },
  left:  { pitch: [0.244, 0.920, 0.364, 0.940], loud: [0.372, 0.920, 0.493, 0.940] },
};

// 이명 Pitch는 항상 표준 청력검사 주파수 중 하나 → 가까운 값으로 보정(스냅)
const TINNITUS_FREQS = [125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];

const RENDER_SCALE = 3.2;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const dropScreen = $("dropScreen");
const resultScreen = $("resultScreen");
const loading = $("loading");
const dropZone = $("dropZone");
const fileInput = $("fileInput");
const dropError = $("dropError");
const deck = $("deck");
const backBtn = $("backBtn");

let ocrWorker = null;
let lastPageCanvas = null;

/* =========================================================
   슬라이드 상태 머신
========================================================= */
const STATES = [
  { page: "audio", sub: "0" },
  { page: "audio", sub: "1" }, // 정상영역 빨간 테두리
  { page: "audio", sub: "2" }, // dB 구간 배경색
  { page: "audio", sub: "3" }, // speech banana + 그림 + 소리듣기
  { page: "tymp" },
  { page: "speech" },
  { page: "tinnitus", callout: true },
  { page: "tinnitus", callout: false }, // 콜아웃만 숨김(동그라미 유지)
];
let state = 0;

function applyState(i) {
  state = Math.max(0, Math.min(STATES.length - 1, i));
  const s = STATES[state];
  deck.querySelectorAll(".page").forEach((p) => { p.hidden = p.dataset.page !== s.page; });
  const audioPage = deck.querySelector('[data-page="audio"]');
  if (s.page === "audio") {
    audioPage.dataset.sub = s.sub;
    $("audioFab").hidden = s.sub !== "3";
    requestAnimationFrame(positionSpeechZoneLabel);
  }
  if (s.page === "tinnitus") {
    deck.querySelectorAll(".tin-callout").forEach((c) => { c.hidden = !s.callout; });
  }
  backBtn.hidden = state === 0;
  $("hint").textContent =
    state === STATES.length - 1 ? "마지막 화면입니다" : "화면을 클릭하면 다음 단계로 넘어갑니다";
  window.scrollTo(0, 0);
}

// "말소리 영역" 라벨을 좌우 그래프 사이, 35dB(30~40dB) 높이에 배치
function positionSpeechZoneLabel() {
  const grid = document.querySelector(".audio-grid");
  const label = document.getElementById("speechZoneLabel");
  const chart = document.getElementById("chartRight");
  if (!grid || !label || !chart) return;
  const g = grid.getBoundingClientRect();
  const c = chart.getBoundingClientRect();
  if (c.height === 0) return;
  label.style.left = "50%";
  label.style.top = (c.top - g.top + 0.348 * c.height) + "px"; // 35dB 부근
}
window.addEventListener("resize", () => {
  if (!resultScreen.hidden) requestAnimationFrame(positionSpeechZoneLabel);
});
function advance() { if (!resultScreen.hidden) applyState(state + 1); }
function goBack() { if (!resultScreen.hidden) applyState(state - 1); }

// 클릭/우클릭으로 진행 (버튼 등 .no-advance 는 제외)
document.addEventListener("click", (e) => {
  if (resultScreen.hidden) return;
  if (e.target.closest(".no-advance") || e.target.closest("#dropScreen")) return;
  advance();
});
document.addEventListener("contextmenu", (e) => {
  if (resultScreen.hidden) return;
  e.preventDefault();
  if (e.target.closest(".no-advance")) return;
  advance();
});
backBtn.addEventListener("click", (e) => { e.stopPropagation(); goBack(); });

/* ---------- 드래그앤드롭 ---------- */
$("pickBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("drag"); }));
dropZone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
dropZone.addEventListener("click", () => fileInput.click());

/* ---------- 소리 듣기 ---------- */
const player = $("player");
$("audioFab").addEventListener("click", (e) => {
  e.stopPropagation();
  const fab = e.currentTarget;
  player.currentTime = 0;
  player.play();
  fab.classList.add("playing");
});
player.addEventListener("ended", () => $("audioFab").classList.remove("playing"));

/* ---------- OCR ---------- */
async function getWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker("eng", 1, {
    workerPath: new URL("./vendor/tesseract/worker.min.js", import.meta.url).href,
    corePath: new URL("./vendor/tesseract/core/", import.meta.url).href,
    langPath: new URL("./vendor/tesseract/lang/", import.meta.url).href,
    gzip: true,
  });
  await ocrWorker.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: "7" });
  return ocrWorker;
}

/* ---------- 메인 처리 ---------- */
async function handleFile(file) {
  dropError.hidden = true;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("PDF 파일만 올릴 수 있어요."); return;
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
    lastPageCanvas = pageCanvas;

    renderStatic(pageCanvas);
    loading.hidden = true;
    resultScreen.hidden = false;
    applyState(0);

    await renderOcr(pageCanvas);
  } catch (err) {
    console.error(err);
    loading.hidden = true;
    dropScreen.hidden = false;
    showError("결과지를 읽지 못했어요. 우리 병원 검사 결과지 PDF가 맞는지 확인해 주세요.");
  }
}
function showError(msg) { dropError.textContent = msg; dropError.hidden = false; }

/* ---------- 자르기 ---------- */
function crop(src, [nx0, ny0, nx1, ny1]) {
  const sx = nx0 * src.width, sy = ny0 * src.height;
  const sw = (nx1 - nx0) * src.width, sh = (ny1 - ny0) * src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function cropMagnify(src, frac, zoom = 3) {
  const [fx0, fy0, fx1, fy1] = frac;
  const sx = fx0 * src.width, sy = fy0 * src.height;
  const sw = (fx1 - fx0) * src.width, sh = (fy1 - fy0) * src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw * zoom); c.height = Math.round(sh * zoom);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function setChart(container, canvas) {
  container.querySelectorAll("canvas, .ovl, .snd-img, .banana-label").forEach((n) => n.remove());
  container.prepend(canvas);
}

/* ---------- 즉시 표시 ---------- */
function renderStatic(pageCanvas) {
  // 오디오그램(좌우 동일 크기) + 오버레이
  setChart($("chartRight"), crop(pageCanvas, AUDIO_DISPLAY.right));
  setChart($("chartLeft"), crop(pageCanvas, AUDIO_DISPLAY.left));
  buildAudioOverlay("right", $("chartRight"));
  buildAudioOverlay("left", $("chartLeft"));

  // 평균 dB (OCR 전 임시: 확대 이미지)
  $("ptaRight").innerHTML = "";
  $("ptaRight").appendChild(cropMagnify(pageCanvas, PTA_OCR.right));
  $("ptaLeft").innerHTML = "";
  $("ptaLeft").appendChild(cropMagnify(pageCanvas, PTA_OCR.left));

  // 임피던스(좌우 동일 크기)
  $("tympRight").querySelectorAll("canvas").forEach((n) => n.remove());
  $("tympRight").prepend(crop(pageCanvas, TYMP_DISPLAY.right));
  $("tympLeft").querySelectorAll("canvas").forEach((n) => n.remove());
  $("tympLeft").prepend(crop(pageCanvas, TYMP_DISPLAY.left));
  $("tympNormal").innerHTML = "";
  const normImg = document.createElement("img");
  normImg.src = "assets/normal_tymp.png";
  normImg.alt = "정상 고막운동성 예시";
  $("tympNormal").appendChild(normImg);

  // 언어청력 캡쳐
  $("speechCapture").querySelectorAll("canvas").forEach((n) => n.remove());
  $("speechCapture").prepend(crop(pageCanvas, REGION.speech));
}

/* ---------- OCR 이후 ---------- */
async function renderOcr(pageCanvas) {
  const worker = await getWorker();
  const ptaOpts = { max: 120, whitelist: "0123456789d. " };
  const rDb = await ocrNumber(worker, pageCanvas, PTA_OCR.right, ptaOpts);
  const lDb = await ocrNumber(worker, pageCanvas, PTA_OCR.left, ptaOpts);
  applyPta("right", rDb);
  applyPta("left", lDb);

  const tin = {};
  for (const side of ["right", "left"]) {
    const pitchRaw = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].pitch, { stripLines: true });
    const loud = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].loud, { max: 120, stripLines: true });
    tin[side] = { pitch: snapPitch(pitchRaw), loud };
  }
  renderTinnitus(pageCanvas, tin);
  applyState(state); // 콜아웃 표시 상태 동기화
}

// OCR로 읽은 Pitch를 가장 가까운 표준 주파수로 보정. 범위를 벗어나면 무시(null).
function snapPitch(n) {
  if (n == null || n < 80 || n > 9000) return null;
  let best = TINNITUS_FREQS[0];
  for (const f of TINNITUS_FREQS) if (Math.abs(f - n) < Math.abs(best - n)) best = f;
  return best;
}

// (테스트/시연용) 양쪽 이명 케이스 미리보기
window.__demoBothTinnitus = () => {
  renderTinnitus(lastPageCanvas, { right: { pitch: 2000, loud: 45 }, left: { pitch: 3000, loud: 30 } });
  applyState(state);
};

function applyPta(side, db) {
  const el = $(side === "right" ? "ptaRight" : "ptaLeft");
  const sig = $(side === "right" ? "sigRight" : "sigLeft");
  if (db == null) { sig.style.background = "#bbb"; return; }
  el.innerHTML = `${db} dB`;
  sig.style.background = signalColor(db);
}
function signalColor(db) {
  if (db <= 25) return "#2ecc40";
  if (db <= 40) return "#ffdf2b";
  if (db <= 55) return "#ff9f1a";
  if (db <= 70) return "#ff5a36";
  if (db <= 90) return "#e02424";
  return "#8e0000";
}

/* ---------- 오디오그램 좌표 ---------- */
function geom(ear) {
  const c = AUDIO_CAL[ear], d = AUDIO_DISPLAY[ear];
  const Wd = d[2] - d[0], Hd = d[3] - d[1];
  const xf = (hz) => (c.x1 + (Math.log10(hz / c.f1) / Math.log10(c.f2 / c.f1)) * (c.x2 - c.x1) - d[0]) / Wd;
  const yf = (db) => (c.y1 + ((db - c.d1) / (c.d2 - c.d1)) * (c.y2 - c.y1) - d[1]) / Hd;
  const xL = (c.bL - d[0]) / Wd, xR = (c.bR - d[0]) / Wd;
  return { xf, yf, xL, xR };
}

/* 오버레이(빨간테두리 / dB구간색 / speech banana + 그림) 구성 */
function buildAudioOverlay(ear, wrap) {
  const g = geom(ear);
  const X = (v) => (v * 100).toFixed(2);
  const SVGNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "ovl");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");

  const rect = (x, y, w, h, attrs) => {
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", X(x)); r.setAttribute("y", X(y));
    r.setAttribute("width", X(w)); r.setAttribute("height", X(h));
    for (const k in attrs) r.setAttribute(k, attrs[k]);
    return r;
  };
  const W = g.xR - g.xL;

  // 1) 정상영역(≤25dB) 빨간 테두리
  const gNormal = document.createElementNS(SVGNS, "g");
  gNormal.setAttribute("class", "g-normal");
  gNormal.appendChild(rect(g.xL, g.yf(-10), W, g.yf(25) - g.yf(-10),
    { fill: "none", stroke: "#d62828", "stroke-width": "9", "vector-effect": "non-scaling-stroke" }));
  svg.appendChild(gNormal);

  // 2) dB 구간 배경색
  const gZones = document.createElementNS(SVGNS, "g");
  gZones.setAttribute("class", "g-zones");
  gZones.appendChild(rect(g.xL, g.yf(25), W, g.yf(40) - g.yf(25), { fill: "rgba(255,236,120,.60)" }));
  gZones.appendChild(rect(g.xL, g.yf(40), W, g.yf(70) - g.yf(40), { fill: "rgba(255,178,90,.55)" }));
  gZones.appendChild(rect(g.xL, g.yf(70), W, g.yf(120) - g.yf(70), { fill: "rgba(255,150,180,.50)" }));
  svg.appendChild(gZones);

  // 3) speech banana (Cochlear 차트 기준 모양)
  const gBanana = document.createElementNS(SVGNS, "g");
  gBanana.setAttribute("class", "g-banana");
  const top = [[250, 20], [400, 26], [600, 30], [800, 32], [1000, 31], [1300, 27], [1700, 22], [2500, 18], [4000, 16], [6000, 17], [8000, 18]];
  const bot = [[8000, 25], [6000, 30], [4000, 40], [2500, 47], [1700, 52], [1300, 57], [1000, 61], [800, 60], [600, 54], [400, 49], [250, 45]];
  let dpath = "";
  top.forEach(([hz, db], i) => { dpath += (i ? "L" : "M") + X(g.xf(hz)) + "," + X(g.yf(db)) + " "; });
  bot.forEach(([hz, db]) => { dpath += "L" + X(g.xf(hz)) + "," + X(g.yf(db)) + " "; });
  dpath += "Z";
  const path = document.createElementNS(SVGNS, "path");
  path.setAttribute("d", dpath);
  path.setAttribute("fill", "rgba(150,152,158,.30)");
  path.setAttribute("stroke", "#7a7d85");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-dasharray", "5 3");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  gBanana.appendChild(path);
  svg.appendChild(gBanana);

  wrap.appendChild(svg);

  // 음소 알파벳 + 소리 그림 — HTML 오버레이
  // 음소 알파벳 (Cochlear 차트 위치 기준 Hz·dB)
  const PHONEMES = [
    ["z", 250, 30], ["v", 320, 30],
    ["p", 1400, 27], ["h", 1500, 33], ["g", 1680, 37],
    ["k", 3000, 30], ["f", 4400, 28], ["s", 5200, 29], ["th", 6000, 28],
    ["ㅅ", 4400, 36], ["ㅈ", 5200, 37], ["ㅆ", 6000, 36],
    ["J", 250, 42], ["m", 330, 41], ["d", 400, 41], ["b", 470, 41],
    ["ch", 1450, 42], ["sh", 1950, 42],
    ["n", 320, 46], ["ng", 345, 50],
    ["e", 330, 54], ["u", 390, 54],
    ["l", 620, 50],
    ["o", 820, 45], ["a", 930, 46], ["r", 1080, 46],
  ];
  for (const [t, hz, db] of PHONEMES) {
    const el = document.createElement("div");
    el.className = "phoneme";
    el.textContent = t;
    pos(el, g.xf(hz), g.yf(db));
    wrap.appendChild(el);
  }

  const imgs = [
    { emo: "🐶", db: 70, fx: 0.32 },
    { emo: "🎹", db: 80, fx: 0.52 },
    { emo: "🚗", db: 97, hz: 500 },
    { emo: "🐦", db: 5, hz: 6000, bird: true },
  ];
  for (const it of imgs) {
    const el = document.createElement("div");
    el.className = "snd-img";
    el.textContent = it.emo;
    const x = "hz" in it ? g.xf(it.hz) : g.xL + it.fx * W;
    pos(el, x, g.yf(it.db));
    if (it.bird) {
      el.classList.add("no-advance");
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => { e.stopPropagation(); playBirdSound(); });
    }
    wrap.appendChild(el);
  }
  function pos(el, fx, fy) {
    el.style.left = (fx * 100).toFixed(2) + "%";
    el.style.top = (fy * 100).toFixed(2) + "%";
  }
}

/* ---------- 새소리 합성 (Web Audio API) ---------- */
function playBirdSound() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  const t0 = ctx.currentTime;
  // [시작(s), 시작주파수(Hz), 최고주파수(Hz), 지속(s)]
  const notes = [
    [0.00, 3500, 4200, 0.07], [0.10, 3800, 4600, 0.06],
    [0.30, 3200, 4000, 0.08], [0.42, 3500, 4300, 0.07],
    [0.70, 3800, 4800, 0.06], [0.80, 3500, 4200, 0.07],
    [1.05, 3200, 4000, 0.09], [1.18, 3600, 4400, 0.07],
    [1.40, 3800, 4600, 0.06], [1.55, 3500, 4300, 0.07],
    [1.80, 3200, 4000, 0.08], [2.00, 3500, 4200, 0.07],
    [2.20, 3800, 4600, 0.06], [2.35, 3500, 4300, 0.07],
    [2.60, 3200, 4000, 0.09], [2.80, 3600, 4400, 0.07],
    [3.00, 3800, 4800, 0.06], [3.15, 3500, 4200, 0.07],
    [3.40, 3200, 4000, 0.08], [3.60, 3500, 4300, 0.07],
    [3.85, 3800, 4600, 0.06], [4.00, 3200, 4000, 0.09],
    [4.20, 3600, 4400, 0.07], [4.45, 3800, 4600, 0.06],
    [4.65, 3500, 4200, 0.07], [4.80, 3200, 4000, 0.08],
  ];
  for (const [tOff, fLo, fHi, dur] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(fLo, t0 + tOff);
    osc.frequency.linearRampToValueAtTime(fHi, t0 + tOff + dur * 0.5);
    osc.frequency.linearRampToValueAtTime(fLo, t0 + tOff + dur);
    gain.gain.setValueAtTime(0, t0 + tOff);
    gain.gain.linearRampToValueAtTime(0.22, t0 + tOff + 0.008);
    gain.gain.setValueAtTime(0.22, t0 + tOff + dur - 0.01);
    gain.gain.linearRampToValueAtTime(0, t0 + tOff + dur);
    osc.start(t0 + tOff);
    osc.stop(t0 + tOff + dur + 0.01);
  }
}

/* ---------- OCR 숫자 ---------- */
async function ocrNumber(worker, src, region, opts = {}) {
  const { max = null, whitelist = "0123456789", stripLines = false } = opts;
  const pre = preprocess(src, region, 4, 30, stripLines);
  if (pre.inkRatio < 0.004) return null;
  await worker.setParameters({ tessedit_char_whitelist: whitelist });
  const { data } = await worker.recognize(pre.canvas);
  // 맨 앞 숫자 묶음만 사용 ("dB" 등 단위 글자는 글자로 인식돼 무시됨)
  const m = (data.text || "").match(/\d{1,4}/);
  if (!m) return null;
  let digits = m[0];
  let n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return null;
  if (max != null) {
    // OCR이 끝에 0을 덧붙이는 오류 보정 (예: 16 -> 160)
    while (n > max && digits.length > 1 && digits.endsWith("0")) {
      digits = digits.slice(0, -1);
      n = parseInt(digits, 10);
    }
    if (n > max) return null;
  }
  return n;
}
function preprocess(src, [nx0, ny0, nx1, ny1], zoom = 4, pad = 30, stripLines = false) {
  const sx = nx0 * src.width, sy = ny0 * src.height;
  const sw = (nx1 - nx0) * src.width, sh = (ny1 - ny0) * src.height;
  const dw = Math.round(sw * zoom), dh = Math.round(sh * zoom);

  // 1) 잘라낸 영역을 딱 맞는 캔버스에 그려 그레이스케일 처리
  const tight = document.createElement("canvas");
  tight.width = dw; tight.height = dh;
  const tctx = tight.getContext("2d");
  tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = "high";
  tctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  const timg = tctx.getImageData(0, 0, dw, dh);
  const td = timg.data;
  for (let i = 0; i < td.length; i += 4) {
    const gg = 0.299 * td[i] + 0.587 * td[i + 1] + 0.114 * td[i + 2];
    td[i] = td[i + 1] = td[i + 2] = gg;
  }
  // 표의 칸 경계선(세로/가로 선)을 지워 "1" 오인식·숫자 누락 방지
  if (stripLines) removeTableLines(td, dw, dh);
  tctx.putImageData(timg, 0, 0);

  // 2) 여백(pad)을 둔 흰 캔버스에 합성
  const c = document.createElement("canvas");
  c.width = dw + pad * 2; c.height = dh + pad * 2;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(tight, pad, pad);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 130) ink++;
  return { canvas: c, inkRatio: ink / (c.width * c.height) };
}

// 표의 칸 경계선(셀을 가득 채우는 검은 세로/가로 선)을 흰색으로 지운다.
// 숫자는 위·아래(또는 좌·우) 끝에 여백이 있어 보존되고, 칸 선만 제거된다.
function removeTableLines(data, w, h) {
  const dark = (x, y) => data[(y * w + x) * 4] < 150;
  // 세로선: 맨 위·맨 아래 픽셀이 모두 검고, 세로로 85% 이상 채워진 열
  for (let x = 0; x < w; x++) {
    if (!dark(x, 0) || !dark(x, h - 1)) continue;
    let cnt = 0;
    for (let y = 0; y < h; y++) if (dark(x, y)) cnt++;
    if (cnt >= 0.85 * h) {
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
  }
  // 가로선: 맨 왼쪽·맨 오른쪽 픽셀이 모두 검고, 가로로 85% 이상 채워진 행
  for (let y = 0; y < h; y++) {
    if (!dark(0, y) || !dark(w - 1, y)) continue;
    let cnt = 0;
    for (let x = 0; x < w; x++) if (dark(x, y)) cnt++;
    if (cnt >= 0.85 * w) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255;
      }
    }
  }
}

/* ---------- 이명검사 ---------- */
function renderTinnitus(pageCanvas, tin) {
  const pageEl = $("tinnitusPage");
  pageEl.innerHTML = "";
  // Pitch·Loudness 둘 다 인식된 쪽 = 이명이 있는 쪽 (한쪽만 읽히면 마커를 못 찍으므로 제외)
  const sides = ["right", "left"].filter((s) => tin[s].pitch != null && tin[s].loud != null);

  const title = (cls) => {
    const h = document.createElement("h2");
    h.className = "page-title" + (cls ? " " + cls : "");
    h.innerHTML = "이명검사 <span>(Tinnitogram)</span>";
    return h;
  };
  const tableCapture = () => {
    const c = document.createElement("article");
    c.className = "capture-card";
    c.appendChild(crop(pageCanvas, REGION.tinnito));
    return c;
  };

  if (sides.length === 2) {
    // 양측 이명: 새 스타일 (제목 우상단 · 표 좌상단 · 청력도 하단)
    const top = document.createElement("div");
    top.className = "tin-top";
    const tbl = document.createElement("div");
    tbl.className = "tin-table";
    tbl.appendChild(crop(pageCanvas, REGION.tinnito));
    top.appendChild(tbl);
    top.appendChild(title("tin-title"));
    pageEl.appendChild(top);

    const charts = document.createElement("div");
    charts.className = "tin-charts";
    for (const side of sides) {
      charts.appendChild(buildTinnitusAudiogram(pageCanvas, side, tin[side].pitch, tin[side].loud));
    }
    pageEl.appendChild(charts);
  } else {
    // 한쪽 이명 또는 기록 없음: 이전 스타일 (제목 상단 중앙 · 청력도+표 나란히)
    pageEl.appendChild(title());
    const grid = document.createElement("div");
    grid.className = "tinnitus-grid";
    if (sides.length === 1) {
      grid.appendChild(buildTinnitusAudiogram(pageCanvas, sides[0], tin[sides[0]].pitch, tin[sides[0]].loud));
    } else {
      const note = document.createElement("div");
      note.className = "tin-note";
      note.textContent = "이명검사에 기록된 수치가 없습니다. 아래 표를 참고하세요.";
      grid.appendChild(note);
    }
    grid.appendChild(tableCapture());
    pageEl.appendChild(grid);
  }
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

  if (pitch != null && loud != null) {
    const g = geom(side);
    const fx = g.xf(pitch), fy = g.yf(loud);
    const marker = document.createElement("span");
    marker.className = "tin-marker";
    marker.style.left = (fx * 100).toFixed(2) + "%";
    marker.style.top = (fy * 100).toFixed(2) + "%";
    wrap.appendChild(marker);

    const callout = document.createElement("span");
    callout.className = "tin-callout";
    callout.textContent = `이명 ${pitch}Hz · ${loud}dB`;
    callout.style.left = (fx * 100).toFixed(2) + "%";
    callout.style.top = "calc(" + (fy * 100).toFixed(2) + "% - 22px)"; // 동그라미 위로 띄움
    wrap.appendChild(callout);
  }
  panel.appendChild(wrap);
  return panel;
}
