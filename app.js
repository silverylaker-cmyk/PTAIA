import * as pdfjsLib from "./vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

/* =========================================================
   우리 병원 결과지 템플릿 좌표 (페이지 비율, 항상 동일)
   [nx0, ny0, nx1, ny1]  (0~1, 좌상단 기준)
========================================================= */
const REGION = {
  rightAudio: [0.041, 0.135, 0.486, 0.449],
  leftAudio:  [0.491, 0.135, 0.960, 0.449],
  rightTymp:  [0.041, 0.460, 0.486, 0.695],
  leftTymp:   [0.491, 0.460, 0.960, 0.695],
  header:     [0.360, 0.029, 0.965, 0.118],
};
// 평균 dB 숫자 위치 (각 오디오그램 영역 내부 비율)
const PTA_CROP = {
  right: [0.245, 0.050, 0.365, 0.092], // 빨강, 왼쪽 위
  left:  [0.715, 0.045, 0.865, 0.094], // 파랑, 오른쪽 위
};

const RENDER_SCALE = 3.2;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const dropScreen = $("dropScreen");
const resultScreen = $("resultScreen");
const dropZone = $("dropZone");
const fileInput = $("fileInput");
const dropError = $("dropError");

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
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag");
  })
);
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});
dropZone.addEventListener("click", () => fileInput.click());

/* ---------- 메인 처리 ---------- */
async function handleFile(file) {
  dropError.hidden = true;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showError("PDF 파일만 올릴 수 있어요.");
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const pageCanvas = document.createElement("canvas");
    pageCanvas.width = viewport.width;
    pageCanvas.height = viewport.height;
    await page.render({ canvasContext: pageCanvas.getContext("2d"), viewport }).promise;
    render(pageCanvas);
    dropScreen.hidden = true;
    resultScreen.hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    showError("결과지를 읽지 못했어요. 우리 병원 검사 결과지 PDF가 맞는지 확인해 주세요.");
  }
}

function showError(msg) {
  dropError.textContent = msg;
  dropError.hidden = false;
}

/* ---------- 영역 잘라내기 ---------- */
function crop(src, [nx0, ny0, nx1, ny1]) {
  const sx = nx0 * src.width;
  const sy = ny0 * src.height;
  const sw = (nx1 - nx0) * src.width;
  const sh = (ny1 - ny0) * src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// 오디오그램 영역 안에서 다시 비율로 잘라 확대 (평균 dB 숫자)
function cropMagnify(audioCanvas, frac, zoom = 2) {
  const [fx0, fy0, fx1, fy1] = frac;
  const sx = fx0 * audioCanvas.width;
  const sy = fy0 * audioCanvas.height;
  const sw = (fx1 - fx0) * audioCanvas.width;
  const sh = (fy1 - fy0) * audioCanvas.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw * zoom);
  c.height = Math.round(sh * zoom);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(audioCanvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

function placeCanvas(container, canvas) {
  // 기존 canvas 제거 후 삽입 (배지/태그 span 은 유지)
  container.querySelectorAll("canvas").forEach((n) => n.remove());
  container.prepend(canvas);
}

/* ---------- 화면 그리기 ---------- */
function render(pageCanvas) {
  // 환자 정보 헤더
  const meta = $("patientMeta");
  meta.innerHTML = "";
  meta.appendChild(crop(pageCanvas, REGION.header));

  // 순음청력 오디오그램
  const rAudio = crop(pageCanvas, REGION.rightAudio);
  const lAudio = crop(pageCanvas, REGION.leftAudio);
  placeCanvas($("chartRight"), rAudio);
  placeCanvas($("chartLeft"), lAudio);

  // 평균 dB (검사지 숫자를 확대해서 그대로 표시)
  $("ptaRight").innerHTML = "";
  $("ptaRight").appendChild(cropMagnify(rAudio, PTA_CROP.right));
  $("ptaLeft").innerHTML = "";
  $("ptaLeft").appendChild(cropMagnify(lAudio, PTA_CROP.left));

  // 임피던스: 오른쪽 / 정상참고 / 왼쪽
  placeCanvas($("tympRight"), crop(pageCanvas, REGION.rightTymp));
  placeCanvas($("tympLeft"), crop(pageCanvas, REGION.leftTymp));
  placeCanvas($("tympNormal"), drawNormalTympanogram());
}

/* ---------- 정상 참고 고막운동성(Type A) 그래프 생성 ---------- */
function drawNormalTympanogram() {
  const W = 480, H = 340;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  const m = { l: 46, r: 16, t: 14, b: 40 };
  const px = (daPa) => m.l + ((daPa + 600) / 900) * (W - m.l - m.r); // -600..300
  const py = (ml) => H - m.b - (ml / 2) * (H - m.t - m.b);           // 0..2

  // 축
  ctx.strokeStyle = "#bbb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(m.l, py(0)); ctx.lineTo(W - m.r, py(0));
  ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, py(0));
  ctx.stroke();
  ctx.fillStyle = "#555";
  ctx.font = "12px sans-serif";
  [-600, -300, 0, 300].forEach((v) => {
    ctx.textAlign = "center";
    ctx.fillText(String(v), px(v), py(0) + 16);
  });
  [0, 1, 2].forEach((v) => {
    ctx.textAlign = "right";
    ctx.fillText(String(v), m.l - 6, py(v) + 4);
  });
  ctx.textAlign = "left";
  ctx.fillText("ml", m.l - 2, m.t - 0);
  ctx.fillText("daPa", W - m.r - 34, py(0) + 30);

  // 정상 범위 박스 (점선)
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#999";
  ctx.strokeRect(px(-150), py(1.6), px(50) - px(-150), py(0.3) - py(1.6));
  ctx.setLineDash([]);

  // Type A 정상 곡선 (가운데 봉우리)
  ctx.strokeStyle = "#149646";
  ctx.lineWidth = 3;
  ctx.beginPath();
  const mu = 0, sigma = 90, peak = 0.95, base = 0.08;
  for (let i = 0; i <= 180; i++) {
    const x = -600 + (i / 180) * 900;
    const y = base + peak * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
    const X = px(x), Y = py(y);
    if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.stroke();

  // 봉우리 표시
  ctx.fillStyle = "#149646";
  ctx.beginPath();
  ctx.moveTo(px(0), py(1.03) - 2);
  ctx.lineTo(px(0) - 7, py(1.03) - 14);
  ctx.lineTo(px(0) + 7, py(1.03) - 14);
  ctx.closePath();
  ctx.fill();
  return c;
}

/* ---------- 평균 dB 직접 입력 → 큰 숫자 + 난청 정도 ---------- */
function classify(db) {
  if (db <= 25) return { t: "정상", c: "#149646" };
  if (db <= 40) return { t: "경도 난청", c: "#e08e0b" };
  if (db <= 55) return { t: "중등도 난청", c: "#e07b0b" };
  if (db <= 70) return { t: "중고도 난청", c: "#d6492c" };
  if (db <= 90) return { t: "고도 난청", c: "#d62828" };
  return { t: "심도 난청", c: "#a01313" };
}

function applyManual(side) {
  const input = side === "right" ? $("inRight") : $("inLeft");
  const ptaEl = side === "right" ? $("ptaRight") : $("ptaLeft");
  const sevEl = side === "right" ? $("sevRight") : $("sevLeft");
  const v = parseInt(input.value, 10);
  if (Number.isNaN(v)) return;
  ptaEl.innerHTML = `${v} dB`;
  const s = classify(v);
  sevEl.textContent = s.t;
  sevEl.style.borderColor = s.c;
  sevEl.style.color = s.c;
  sevEl.hidden = false;
}
$("inRight").addEventListener("input", () => applyManual("right"));
$("inLeft").addEventListener("input", () => applyManual("left"));
