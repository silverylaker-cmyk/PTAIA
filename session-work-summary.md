# OCR 수정 작업 요약 (2026-06-17)

## 작업 브랜치
- 수정 브랜치: `claude/session-context-summary-f40l80`
- 수정 커밋: `d368ac3`
- 백업 태그: `backup-before-ocr-fix-20260617-024841` (수정 전 상태, 커밋 `9460243`)

## 원래 작업 세션 브랜치에 적용하는 방법
```bash
git checkout claude/audiometry-report-reformatter-i2x0is
git cherry-pick d368ac3
# 또는
git merge claude/session-context-summary-f40l80
```

## 롤백 방법
```bash
git reset --hard backup-before-ocr-fix-20260617-024841
git push --force origin claude/session-context-summary-f40l80
```

---

## 발견된 오류 목록 및 원인

| 파일 | 증상 | 원인 |
|------|------|------|
| 56659, 57173, 57201 | PTA 좌측 3자리→1자리 (101→1, 106→6, 102→2) | `PTA_OCR.left` x0=0.826이 백의 자리 숫자를 잘라냄 |
| 57137 | 이명 loudness 75→15 | 표 셀 왼쪽 경계선이 crop에 포함 → OCR이 "1"로 오인식 |
| 27684 | 이명 pitch 500→1500, loud 25→125 | 표 셀 경계선 "1" 오인식 |
| 56734 | 이명 pitch 2000→1200, loud 25→125 | 표 셀 경계선 "1" 오인식 (`\d{1,4}` 캡쳐로 1200) |
| 4404, 56742, 57156 | 이명 마커 미표시 | 경계선 노이즈로 loud OCR 실패(null) → 마커 skip |
| 57107, 57329 | 양쪽 이명인데 오른쪽만 표시 | 좌측 pitch OCR 실패(null) → sides 필터에서 좌측 제거 |

---

## 수정 내용 (`app.js` 만 변경)

### A. PTA_OCR 좌측 x0 조정 (line ~17)
```js
// BEFORE:
left: [0.826, 0.1495, 0.902, 0.1600],
// AFTER (x0: 0.826 → 0.818, 백의 자리 숫자 포함):
left: [0.818, 0.1495, 0.902, 0.1600],
```

### B. TINNITO_CELLS 좌표 조정 (line ~40)
```js
// BEFORE:
right: { pitch: [0.2385, 0.900, 0.363, 0.917], loud: [0.369, 0.900, 0.493, 0.917] },
left:  { pitch: [0.2385, 0.921, 0.363, 0.937], loud: [0.369, 0.921, 0.493, 0.937] },

// AFTER (x0 우측 이동으로 표 경계선 제외, row 범위 미세 조정):
right: { pitch: [0.244, 0.899, 0.364, 0.919], loud: [0.372, 0.899, 0.493, 0.919] },
left:  { pitch: [0.244, 0.920, 0.364, 0.940], loud: [0.372, 0.920, 0.493, 0.940] },
```

### C. 표준 이명 주파수 목록 추가
```js
const TINNITUS_FREQS = [125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];
```

### D. snapPitch() 함수 추가
OCR 결과를 가장 가까운 표준 청력검사 주파수로 snap:
```js
function snapPitch(n) {
  if (n == null || n < 80 || n > 9000) return null;
  let best = TINNITUS_FREQS[0];
  for (const f of TINNITUS_FREQS) if (Math.abs(f - n) < Math.abs(best - n)) best = f;
  return best;
}
```

### E. removeTableLines() 함수 추가
표 셀 경계선(세로/가로) 픽셀을 흰색으로 지우는 전처리:
- 조건: 열/행의 양 끝이 어둡고 ≥85%가 어두운 경우 → 테두리 선으로 판단
```js
function removeTableLines(data, w, h) {
  const dark = (x, y) => data[(y * w + x) * 4] < 150;
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
```

### F. preprocess() 수정 — stripLines 파라미터 추가
```js
// BEFORE:
function preprocess(src, [nx0, ny0, nx1, ny1], zoom = 4, pad = 30) {
  ...
  // removeTableLines 없음
// AFTER:
function preprocess(src, [nx0, ny0, nx1, ny1], zoom = 4, pad = 30, stripLines = false) {
  ...
  if (stripLines) removeTableLines(td, dw, dh);
```

### G. ocrNumber() — stripLines 옵션 전달
```js
// BEFORE:
async function ocrNumber(worker, src, region, opts = {}) {
  const { max = null, whitelist = "0123456789" } = opts;
  const pre = preprocess(src, region);
// AFTER:
async function ocrNumber(worker, src, region, opts = {}) {
  const { max = null, whitelist = "0123456789", stripLines = false } = opts;
  const pre = preprocess(src, region, 4, 30, stripLines);
```

### H. renderOcr() — 이명 OCR 호출부 수정
```js
// BEFORE:
const pitch = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].pitch);
const loud = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].loud, { max: 130 });
tin[side] = { pitch, loud };

// AFTER (stripLines 활성화, snapPitch 적용, loud 최대값 120으로 조정):
const pitchRaw = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].pitch, { stripLines: true });
const loud = await ocrNumber(worker, pageCanvas, TINNITO_CELLS[side].loud, { max: 120, stripLines: true });
tin[side] = { pitch: snapPitch(pitchRaw), loud };
```

### I. renderTinnitus() — sides 필터 강화
```js
// BEFORE:
const sides = ["right", "left"].filter((s) => tin[s].pitch != null);
// AFTER (pitch + loud 둘 다 있어야 마커 표시):
const sides = ["right", "left"].filter((s) => tin[s].pitch != null && tin[s].loud != null);
```

---

## 브라우저 검증 필요 항목

로컬 tesseract(v5.3)는 tesseract.js보다 인식률이 낮아서 수치 검증은 불가능했습니다.
기하학적 검증(픽셀 이미지로 crop 영역 확인)만 완료된 상태입니다.

실제 브라우저에서 다음 파일들을 확인해 주세요:

| 파일 | 확인 항목 |
|------|----------|
| 56659 | PTA 좌측 → 101 표시 |
| 57173 | PTA 좌측 → 106 표시 |
| 57201 | PTA 좌측 → 102 표시 |
| 57137 | 이명 loudness → 75 표시, 마커 위치 올바름 |
| 27684 | 이명 pitch → 500, loud → 25 |
| 56734 | 이명 pitch → 2000, loud → 25 |
| 4404  | 이명 마커 표시됨 |
| 56742 | 이명 마커 표시됨 |
| 57156 | 이명 마커 표시됨 |
| 57107 | 양쪽 오디오그램에 각각 마커 표시 |
| 57329 | 양쪽 오디오그램에 각각 마커 표시 |
