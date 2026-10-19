// Forest Change Explorer
// Answers "where has the forest died, since when, and how sure can we be?" from a stack of
// Sentinel-2 observations. No dependencies: canvas for the map, SVG for charts.
// Data contract: see pipeline/dataset.py.

const $ = (s) => document.querySelector(s);
const DATA = "data/";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ colour
const NDVI_STOPS = [
  [-0.2, [70, 56, 44]], [0.15, [128, 104, 76]], [0.35, [196, 180, 124]],
  [0.55, [140, 180, 96]], [0.75, [52, 128, 70]], [1.0, [14, 72, 42]],
];
// First year of loss: early = deep violet, recent = pale gold.
const ONSET = ["#6a2a8c", "#a23178", "#d0445d", "#ec6a45", "#f59c3c", "#f8cc58", "#fcef9e"];
const HEALTHY = "#86bfa0";

function lerpStops(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i];
    if (v <= x1) {
      const [x0, c0] = stops[i - 1];
      const t = (v - x0) / (x1 - x0);
      return c0.map((c, k) => c + (c1[k] - c) * t);
    }
  }
  return stops[stops.length - 1][1];
}
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const firstChangeYear = () => S.years.find((y) => !S.m.baselineYears.includes(y));
const onsetColour = (y) => ONSET[Math.max(0, Math.min(ONSET.length - 1, y - firstChangeYear()))];

// ------------------------------------------------------------------ state
const S = {
  m: null, years: [], yearIdx: 0, layer: "change",
  compare: false, swipe: 0.5, areaMode: false, area: null, point: null, hover: null,
  view: { s: 1, x: 0, y: 0 }, fitScale: 1, fitted: false,
  ndvi: [], rgbImg: [], ndviCanvas: [],
  base: null, onset: null, missing: null,
  series: null, dates: [], dateYear: [],
  playing: null, fade: null, lastSrc: null,
};

// ------------------------------------------------------------------ load
async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}
function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function readGrey(img) {
  const c = canvasOf(img.width, img.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}
const decodeVal = (v) => { const e = S.m.ndviEncoding; return v === e.nodata ? NaN : e.min + (v / e.scale) * (e.max - e.min); };

async function load() {
  const m = await (await fetch(DATA + "manifest.json")).json();
  S.m = m;
  S.years = m.years;
  S.yearIdx = S.years.length - 1;
  const [rgb, ndvi, series] = await Promise.all([
    Promise.all(m.composites.map((c) => loadImage(DATA + c.rgb))),
    Promise.all(m.composites.map((c) => loadImage(DATA + c.ndvi))),
    loadImage(DATA + m.series.file),
  ]);
  S.rgbImg = rgb;
  S.ndvi = ndvi.map((img) => Float32Array.from(readGrey(img), decodeVal));
  S.series = readGrey(series); // [date][row][col]
  S.dates = m.series.dates.map((d) => new Date(d + "T12:00:00Z"));
  S.dateYear = S.dates.map((d) => d.getUTCFullYear());
  S.ndviCanvas = S.ndvi.map(paintNdvi);
  analyse();
}

// ------------------------------------------------------------------ analysis
// Baseline = mean summer NDVI of the baseline years; only pixels >= 0.55 count as forest.
// Loss = more than `lossThreshold` below baseline in two consecutive clear summers; the first is
// the loss year. Regreening later does not undo the loss; it is reported separately.
function analyse() {
  const { width: w, height: h, baselineYears, lossThreshold: thr } = S.m;
  const n = w * h;
  const baseIdx = baselineYears.map((y) => S.years.indexOf(y)).filter((i) => i >= 0);
  S.baseIdx = baseIdx;
  S.base = new Float32Array(n);
  S.onset = new Int16Array(n);
  S.missing = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    let sum = 0, k = 0;
    for (const i of baseIdx) { const v = S.ndvi[i][p]; if (v === v) { sum += v; k++; } }
    const base = k ? sum / k : NaN;
    S.base[p] = base;
    for (let i = 0; i < S.years.length; i++) if (S.ndvi[i][p] !== S.ndvi[i][p]) { S.missing[p] = 1; break; }
    S.onset[p] = base >= 0.55 ? onsetFor((i) => S.ndvi[i][p], base, thr) : 0;
  }
}
function onsetFor(get, base, thr) {
  const clear = [];
  for (let i = 0; i < S.years.length; i++) {
    if (S.baseIdx.includes(i)) continue;
    const v = get(i);
    if (v === v) clear.push([S.years[i], v < base - thr]);
  }
  for (let k = 0; k < clear.length - 1; k++) if (clear[k][1] && clear[k + 1][1]) return clear[k][0];
  return -1;
}
const regreened = (p, idx) => { const v = S.ndvi[idx][p]; return v === v && v >= S.base[p] - S.m.lossThreshold; };

function cellSeries(col, row) {
  const { rows, cols } = S.m.series;
  const per = rows * cols;
  return S.dates.map((_, t) => decodeVal(S.series[t * per + row * cols + col]));
}
function summerMedians(pts) {
  const by = new Map(S.years.map((y) => [y, []]));
  pts.forEach((v, t) => {
    if (v !== v) return;
    const d = S.dates[t];
    const md = d.getUTCMonth() * 100 + d.getUTCDate(); // months are 0-based
    if (md >= 510 && md <= 731) by.get(S.dateYear[t])?.push(v);
  });
  const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return S.years.map((y) => ({ year: y, v: med(by.get(y)), n: by.get(y).length }));
}

// ------------------------------------------------------------------ raster layers
function paintNdvi(arr) {
  const { width: w, height: h } = S.m;
  const c = canvasOf(w, h);
  const g = c.getContext("2d");
  const id = g.createImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4, v = arr[p];
    const [r, gg, b] = v === v ? lerpStops(NDVI_STOPS, v) : [40, 44, 46];
    id.data[o] = r; id.data[o + 1] = gg; id.data[o + 2] = b; id.data[o + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return c;
}
const changeCache = new Map();
function paintChange(idx) {
  if (changeCache.has(idx)) return changeCache.get(idx);
  const { width: w, height: h } = S.m;
  const upto = S.years[idx];
  const c = canvasOf(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.filter = "grayscale(1) brightness(0.62) contrast(1.05)";
  g.drawImage(S.rgbImg[idx], 0, 0);
  g.filter = "none";
  const id = g.getImageData(0, 0, w, h);
  for (let p = 0; p < w * h; p++) {
    const y = S.onset[p];
    if (y > 0 && y <= upto) {
      const [r, gg, b] = hexRgb(onsetColour(y));
      const a = regreened(p, idx) ? 0.38 : 1;
      const o = p * 4;
      id.data[o] += (r - id.data[o]) * a;
      id.data[o + 1] += (gg - id.data[o + 1]) * a;
      id.data[o + 2] += (b - id.data[o + 2]) * a;
    }
  }
  g.putImageData(id, 0, 0);
  changeCache.set(idx, c);
  return c;
}
function layerSource(layer, idx) {
  if (layer === "rgb") return S.rgbImg[idx];
  if (layer === "ndvi") return S.ndviCanvas[idx];
  return paintChange(idx);
}

// ------------------------------------------------------------------ map
const mapEl = $("#map");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let dpr = 1, raf = 0;

function resize() {
  const r = mapEl.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const keep = S.fitted && S.view.s > S.fitScale * 1.02;
  fit(keep);
  draw();
}
function fit(keepZoom = false) {
  const r = mapEl.getBoundingClientRect();
  // cover the frame: the area fills the map; edges can be panned into view
  const s = Math.max(r.width / S.m.width, r.height / S.m.height);
  S.fitScale = s;
  if (!keepZoom) S.view = { s, x: (r.width - S.m.width * s) / 2, y: (r.height - S.m.height * s) / 2 };
  S.fitted = true;
  clampView();
}
function clampView() {
  const r = mapEl.getBoundingClientRect();
  const v = S.view;
  v.s = Math.min(Math.max(v.s, S.fitScale), S.fitScale * 14);
  const W = S.m.width * v.s, H = S.m.height * v.s;
  v.x = Math.min(0, Math.max(r.width - W, v.x));
  v.y = Math.min(0, Math.max(r.height - H, v.y));
  mapEl.classList.toggle("zoomed", v.s > S.fitScale * 1.02);
}
const toData = (sx, sy) => [(sx - S.view.x) / S.view.s, (sy - S.view.y) / S.view.s];
const toScreen = (dx, dy) => [S.view.x + dx * S.view.s, S.view.y + dy * S.view.s];

function requestDraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function setSource(src) {
  if (S.lastSrc && S.lastSrc !== src && !REDUCED) S.fade = { from: S.lastSrc, t0: performance.now() };
  S.lastSrc = src;
}

function draw() {
  if (!S.m) return;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  const { s, x, y } = S.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#040607";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = s < 2.5;
  const put = (src, a = 1) => { ctx.globalAlpha = a; ctx.drawImage(src, x, y, S.m.width * s, S.m.height * s); ctx.globalAlpha = 1; };

  const src = layerSource(S.layer, S.yearIdx);
  setSource(src);
  if (S.fade) {
    const t = Math.min(1, (performance.now() - S.fade.t0) / 260);
    put(S.fade.from);
    put(src, t * t * (3 - 2 * t));
    if (t < 1) requestDraw(); else S.fade = null;
  } else put(src);

  if (S.compare) {
    const cut = S.swipe * W;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, cut, H); ctx.clip();
    put(layerSource(S.layer === "change" ? "rgb" : S.layer, 0));
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillRect(cut - 0.75, 0, 1.5, H);
    ctx.beginPath(); ctx.arc(cut, H / 2, 15, 0, Math.PI * 2);
    ctx.fillStyle = "#e7ece9"; ctx.fill();
    ctx.fillStyle = "#070a0b";
    for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cut + d * 3, H / 2 - 4.5); ctx.lineTo(cut + d * 8, H / 2); ctx.lineTo(cut + d * 3, H / 2 + 4.5); ctx.fill(); }
  }

  if (S.area) drawArea(normArea(S.area), W, H);
  drawGraticule(W, H);
  if (S.point) drawReticle();
  drawScale();
}

function drawArea(a, W, H) {
  const [x0, y0] = toScreen(a.x0, a.y0), [x1, y1] = toScreen(a.x1, a.y1);
  ctx.fillStyle = "rgba(4,6,7,0.58)";
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.fill("evenodd");
  ctx.strokeStyle = "rgba(169,219,232,0.95)";
  ctx.lineWidth = 2;
  const L = Math.min(16, (x1 - x0) / 3, (y1 - y0) / 3);
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    ctx.moveTo(cx + dx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * L);
  }
  ctx.stroke();
  ctx.strokeStyle = "rgba(169,219,232,0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function drawReticle() {
  const c = S.m.series.cellSizePx;
  const [cx, cy] = toScreen((S.point.col + 0.5) * c, (S.point.row + 0.5) * c);
  const half = (c * S.view.s) / 2;
  const r = Math.max(half * 1.25, 9);
  const arm = 9;
  const path = () => {
    ctx.beginPath();
    ctx.rect(cx - half, cy - half, half * 2, half * 2);
    ctx.moveTo(cx - r - arm, cy); ctx.lineTo(cx - r, cy);
    ctx.moveTo(cx + r, cy); ctx.lineTo(cx + r + arm, cy);
    ctx.moveTo(cx, cy - r - arm); ctx.lineTo(cx, cy - r);
    ctx.moveTo(cx, cy + r); ctx.lineTo(cx, cy + r + arm);
  };
  ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(0,0,0,0.6)"; path(); ctx.stroke();
  ctx.lineWidth = 1.5; ctx.strokeStyle = "#ffffff"; path(); ctx.stroke();
}

function drawGraticule(W, H) {
  const [w, s, e, n] = S.m.bbox;
  const pxLon = (lon) => toScreen(((lon - w) / (e - w)) * S.m.width, 0)[0];
  const pxLat = (lat) => toScreen(0, ((n - lat) / (n - s)) * S.m.height)[1];
  const pxPerDeg = (S.m.width * S.view.s) / (e - w);
  const step = [0.005, 0.01, 0.02, 0.05].find((d) => d * pxPerDeg > 70) || 0.05;
  ctx.font = "400 9px 'Martian Mono', ui-monospace, monospace";
  ctx.fillStyle = "rgba(231,236,233,0.8)";
  ctx.strokeStyle = "rgba(231,236,233,0.6)";
  ctx.lineWidth = 1;
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 3;
  ctx.textBaseline = "top"; ctx.textAlign = "center";
  for (let lon = Math.ceil(w / step) * step; lon < e; lon += step) {
    const x = pxLon(lon);
    if (x < 40 || x > W - 40) continue;
    if (x < 250 && !$("#readout").hidden) continue;
    if (!S.touched && Math.abs(x - W / 2) < 175) continue; // under the hint
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 6); ctx.stroke();
    if (!S.compare) ctx.fillText(`${lon.toFixed(3)}°E`, x, 8);
  }
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  const latStep = step / 1.6;
  for (let lat = Math.ceil(s / latStep) * latStep; lat < n; lat += latStep) {
    const y = pxLat(lat);
    if (y < 60 || y > H - 50) continue;
    ctx.beginPath(); ctx.moveTo(W, y); ctx.lineTo(W - 6, y); ctx.stroke();
    ctx.fillText(`${lat.toFixed(3)}°N`, W - 9, y);
  }
  ctx.shadowBlur = 0;
}

function drawScale() {
  const mPerCss = S.m.pixelSizeM / S.view.s;
  const target = 80 * mPerCss;
  const nice = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000].find((v) => v >= target * 0.6) || 5000;
  $("#scale .scale-bar").style.width = `${nice / mPerCss}px`;
  $("#scale .scale-text").textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
}

// ------------------------------------------------------------------ readout
function pixelLatLon(px, py) {
  const [w, s, e, n] = S.m.bbox;
  return [n - (py / S.m.height) * (n - s), w + (px / S.m.width) * (e - w)];
}
function renderReadout() {
  const el = $("#readout");
  const src = S.hover || (S.touched && S.point && { px: (S.point.col + 0.5) * S.m.series.cellSizePx, py: (S.point.row + 0.5) * S.m.series.cellSizePx });
  const was = el.hidden;
  if (!src || S.compare) { el.hidden = true; if (!was) requestDraw(); return; }
  const px = Math.floor(src.px), py = Math.floor(src.py);
  if (px < 0 || py < 0 || px >= S.m.width || py >= S.m.height) { el.hidden = true; return; }
  const p = py * S.m.width + px;
  const [lat, lon] = pixelLatLon(px + 0.5, py + 0.5);
  const v = S.ndvi[S.yearIdx][p];
  const o = S.onset[p];
  const yr = S.years[S.yearIdx];
  const state = o === 0 ? "not forest in 2017–18"
    : o > 0 && o <= yr ? `lost ${o}${regreened(p, S.yearIdx) ? ", green again" : ""}`
    : o > 0 ? `intact (lost ${o})` : "intact";
  if (was) requestDraw();
  el.innerHTML = `<b>${lat.toFixed(5)}</b> N  <b>${lon.toFixed(5)}</b> E\nNDVI ${yr}  <b>${v === v ? v.toFixed(2) : "cloud"}</b>\nCanopy     <b>${state}</b>`;
  el.hidden = false;
}

// ------------------------------------------------------------------ map interaction
const pointers = new Map();
let gesture = null;
const pos = (e) => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

mapEl.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  mapEl.setPointerCapture(e.pointerId);
  const [px, py] = pos(e);
  pointers.set(e.pointerId, { x: px, y: py });
  if (pointers.size === 1) {
    if (S.compare && Math.abs(px - S.swipe * mapEl.clientWidth) < 26) gesture = { type: "swipe" };
    else if (S.areaMode) {
      const [dx, dy] = toData(px, py);
      S.area = { x0: dx, y0: dy, x1: dx, y1: dy };
      gesture = { type: "area" };
    } else gesture = { type: "pan", sx: px, sy: py, vx: S.view.x, vy: S.view.y, t: performance.now(), moved: 0 };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...S.view } };
  }
});
mapEl.addEventListener("pointermove", (e) => {
  const [px, py] = pos(e);
  if (e.pointerType === "mouse" && !pointers.size) {
    const [dx, dy] = toData(px, py);
    S.hover = { px: dx, py: dy };
    renderReadout();
    return;
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: px, y: py });
  if (!gesture) return;
  if (gesture.type === "swipe") S.swipe = Math.min(0.98, Math.max(0.02, px / mapEl.clientWidth));
  else if (gesture.type === "area") { const [dx, dy] = toData(px, py); S.area.x1 = dx; S.area.y1 = dy; }
  else if (gesture.type === "pan") {
    gesture.moved = Math.max(gesture.moved, Math.hypot(px - gesture.sx, py - gesture.sy));
    if (gesture.moved > 4) mapEl.classList.add("panning");
    S.view.x = gesture.vx + px - gesture.sx;
    S.view.y = gesture.vy + py - gesture.sy;
    clampView();
  } else if (gesture.type === "pinch" && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    zoomAt(gesture.cx, gesture.cy, (gesture.view.s * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.d, gesture.view);
  }
  requestDraw();
});
mapEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { S.hover = null; renderReadout(); } });
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const [px, py] = pos(e);
  pointers.delete(e.pointerId);
  mapEl.classList.remove("panning");
  if (gesture?.type === "pan" && gesture.moved < 6 && performance.now() - gesture.t < 600) inspect(px, py);
  if (gesture?.type === "area") {
    const a = normArea(S.area);
    if ((a.x1 - a.x0) * (a.y1 - a.y0) < 30) S.area = null;
    setAreaMode(false);
    scopeChanged();
  }
  gesture = null;
  requestDraw();
}
mapEl.addEventListener("pointerup", endPointer);
mapEl.addEventListener("pointercancel", endPointer);
mapEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [px, py] = pos(e);
  zoomAt(px, py, S.view.s * Math.exp(-e.deltaY * 0.0015), S.view);
  requestDraw();
}, { passive: false });
function zoomAt(cx, cy, newS, from) {
  const dx = (cx - from.x) / from.s, dy = (cy - from.y) / from.s;
  S.view.s = newS;
  S.view.x = cx - dx * newS;
  S.view.y = cy - dy * newS;
  clampView();
}
$("#btn-fit").addEventListener("click", () => { fit(); requestDraw(); });

function normArea(a) {
  const { width: w, height: h } = S.m;
  const c = (v, m) => Math.max(0, Math.min(m, v));
  return {
    x0: Math.floor(c(Math.min(a.x0, a.x1), w)), x1: Math.ceil(c(Math.max(a.x0, a.x1), w)),
    y0: Math.floor(c(Math.min(a.y0, a.y1), h)), y1: Math.ceil(c(Math.max(a.y0, a.y1), h)),
  };
}
function inspect(sx, sy) {
  const [dx, dy] = toData(sx, sy);
  if (dx < 0 || dy < 0 || dx >= S.m.width || dy >= S.m.height) return;
  const c = S.m.series.cellSizePx;
  S.point = { col: Math.min(S.m.series.cols - 1, Math.floor(dx / c)), row: Math.min(S.m.series.rows - 1, Math.floor(dy / c)) };
  $("#hint").style.opacity = 0;
  S.touched = true;
  renderSpot();
  renderReadout();
  requestDraw();
  if (innerWidth < 1000) $("#spot").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
}

// ------------------------------------------------------------------ controls
function setLayer(l) {
  S.layer = l;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.layer === l)));
  renderLegend();
  renderCompareLabels();
  requestDraw();
}
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer)));
$("#btn-compare").addEventListener("click", () => {
  S.compare = !S.compare;
  $("#btn-compare").setAttribute("aria-pressed", String(S.compare));
  mapEl.classList.toggle("comparing", S.compare);
  if (S.compare && S.yearIdx === 0) setYear(S.years.length - 1);
  renderCompareLabels();
  renderReadout();
  requestDraw();
});
function setAreaMode(on) {
  S.areaMode = on;
  $("#btn-area").setAttribute("aria-pressed", String(on));
  $("#btn-area").textContent = on ? "Drag on the map" : "Select area";
}
$("#btn-area").addEventListener("click", () => setAreaMode(!S.areaMode));
function renderCompareLabels() {
  $("#cmp-left").hidden = $("#cmp-right").hidden = !S.compare;
  $("#legend").hidden = S.compare;
  if (!S.compare) return;
  const name = { rgb: "Imagery", ndvi: "Vegetation", change: "Loss" };
  $("#cmp-left").textContent = `${S.years[0]} · ${S.layer === "change" ? "Imagery" : name[S.layer]}`;
  $("#cmp-right").textContent = `${S.years[S.yearIdx]} · ${name[S.layer]}`;
}
function renderLegend() {
  const el = $("#legend");
  if (S.layer === "rgb") { el.innerHTML = `<div class="lbl">True colour · summer median</div>`; return; }
  if (S.layer === "ndvi") {
    const ramp = NDVI_STOPS.map(([v, c]) => `rgb(${c.map(Math.round)}) ${((v + 0.2) / 1.2) * 100}%`).join(",");
    el.innerHTML = `<div class="lbl">Vegetation index (NDVI)</div><div class="ramp" style="background:linear-gradient(90deg,${ramp})"></div><div class="ends"><span>bare</span><span>dense</span></div>`;
    return;
  }
  const ys = S.years.filter((y) => y >= firstChangeYear());
  el.innerHTML = `<div class="lbl">Canopy lost · first year</div>
    <div class="ramp" style="background:linear-gradient(90deg,${ys.map((y) => onsetColour(y)).join(",")})"></div>
    <div class="ends"><span>${ys[0]}</span><span>${ys.at(-1)}</span></div>
    <div class="faded"><i></i>Faded: green again</div>`;
}

// ------------------------------------------------------------------ scope statistics
const haPerPx = () => (S.m.pixelSizeM ** 2) / 10000;
function scopeStats() {
  const { width: w, height: h } = S.m;
  const a = S.area ? normArea(S.area) : { x0: 0, y0: 0, x1: w, y1: h };
  const idx = S.yearIdx, upto = S.years[idx];
  let forest = 0, lost = 0, missing = 0, green = 0;
  const byYear = new Map(S.years.map((y) => [y, 0]));
  for (let yy = a.y0; yy < a.y1; yy++) for (let xx = a.x0; xx < a.x1; xx++) {
    const p = yy * w + xx, o = S.onset[p];
    if (o === 0) continue;
    forest++;
    if (S.missing[p]) missing++;
    if (o > 0) {
      byYear.set(o, byYear.get(o) + 1);
      if (o <= upto) { lost++; if (regreened(p, idx)) green++; }
    }
  }
  const { cellSizePx: c, rows, cols } = S.m.series;
  const per = rows * cols, nod = S.m.ndviEncoding.nodata;
  let before = 0, after = 0, cells = 0;
  for (let r = Math.floor(a.y0 / c); r < Math.min(rows, Math.ceil(a.y1 / c)); r++)
    for (let cc = Math.floor(a.x0 / c); cc < Math.min(cols, Math.ceil(a.x1 / c)); cc++) {
      cells++;
      for (let t = 0; t < S.dates.length; t++) {
        if (S.series[t * per + r * cols + cc] === nod) continue;
        const y = S.dateYear[t];
        if (S.m.baselineYears.includes(y)) before++;
        else if (y <= upto && y > upto - 2) after++;
      }
    }
  const k = haPerPx();
  return {
    a, upto, whole: !S.area, areaHa: (a.x1 - a.x0) * (a.y1 - a.y0) * k,
    forestHa: forest * k, lostHa: lost * k, share: forest ? lost / forest : 0,
    greenShare: lost ? green / lost : 0, missingShare: forest ? missing / forest : 0,
    byYear, before: cells ? before / cells : 0, after: cells ? after / cells : 0,
  };
}
function confidence(st) {
  if (S.m.baselineYears.includes(st.upto)) return { level: 0, label: "n/a", why: `${st.upto} is part of the baseline, so there is nothing to compare yet.` };
  const minObs = Math.min(st.before, st.after);
  const level = minObs >= 15 && st.missingShare < 0.1 ? 3 : minObs >= 6 && st.missingShare < 0.3 ? 2 : 1;
  const why = `Rests on about ${Math.round(st.before)} cloud-free views per 200 m square in ${S.m.baselineYears.join(" and ")}, and ${Math.round(st.after)} in the two summers up to ${st.upto}. ` +
    (st.missingShare > 0.02 ? `${Math.round(st.missingShare * 100)}% of the forest had a summer with no clear view, so some loss years may be late by a year.` : "Every forest pixel had a clear view every summer.") +
    (st.upto === S.years.at(-1) ? ` Loss first seen in ${st.upto} cannot be confirmed until next summer.` : "");
  return { level, label: ["n/a", "Low", "Medium", "High"][level], why };
}
const fmtArea = (ha) => ha < 100 ? `${Math.round(ha)} ha` : `${(ha / 100).toFixed(ha < 1000 ? 1 : 0)} km²`;

// ------------------------------------------------------------------ timeline (the loss chart is the year picker)
let scopeCache = null;
function renderYears() {
  const st = scopeCache;
  const maxClear = Math.max(...S.m.composites.map((c) => c.clearObs), 1);
  const maxLoss = Math.max(...S.years.map((y) => st.byYear.get(y)), 1);
  const k = haPerPx();
  $("#years").innerHTML = S.years.map((y, i) => {
    const isBase = S.m.baselineYears.includes(y);
    const n = st.byYear.get(y);
    const col = isBase
      ? `<span class="base">base</span>`
      : `<span class="ha">${n ? fmtArea(n * k) : ""}</span><span class="loss" style="height:${n ? Math.max(2, (34 * n) / maxLoss) : 1}px;background:${n ? onsetColour(y) : "var(--line)"}"></span>`;
    return `<div class="yr" data-i="${i}"><div class="col">${col}</div><div class="y">${y}</div>
      <div class="q" title="${S.m.composites[i].clearObs} cloud-free views per pixel (median)"><i style="width:${(100 * S.m.composites[i].clearObs) / maxClear}%"></i></div></div>`;
  }).join("");
  $("#cap-left").textContent = st.whole ? "Forest lost each year, whole area" : "Forest lost each year, selected area";
  markYear();
}
function markYear() {
  document.querySelectorAll(".yr").forEach((el, k) => {
    el.classList.toggle("on", k === S.yearIdx);
    el.classList.toggle("after", k > S.yearIdx);
  });
  const sl = $("#years");
  sl.setAttribute("aria-valuemin", S.years[0]);
  sl.setAttribute("aria-valuemax", S.years.at(-1));
  sl.setAttribute("aria-valuenow", S.years[S.yearIdx]);
}
(function wireYears() {
  const el = $("#years");
  const pick = (e) => {
    const r = el.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * S.years.length);
    setYear(Math.max(0, Math.min(S.years.length - 1, i)));
  };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); stopPlay(); pick(e); });
  el.addEventListener("pointermove", (e) => { if (e.buttons) pick(e); });
  el.addEventListener("keydown", (e) => {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (d) { setYear(Math.max(0, Math.min(S.years.length - 1, S.yearIdx + d))); e.preventDefault(); }
  });
})();

function setYear(i) {
  if (i === S.yearIdx && S.ready) return;
  S.yearIdx = i;
  scopeCache = scopeStats();
  markYear();
  renderCompareLabels();
  renderVerdict();
  if (S.point) renderSpot();
  renderReadout();
  requestDraw();
}
function scopeChanged() { scopeCache = scopeStats(); renderYears(); renderVerdict(); requestDraw(); }

function stopPlay() {
  clearInterval(S.playing);
  S.playing = null;
  $("#play-icon").setAttribute("d", "M4 2.5v11l9-5.5z");
}
$("#btn-play").addEventListener("click", () => {
  if (S.playing) return stopPlay();
  $("#play-icon").setAttribute("d", "M4 2.5h3v11H4zM9 2.5h3v11H9z");
  if (S.yearIdx === S.years.length - 1) setYear(0);
  S.playing = setInterval(() => (S.yearIdx >= S.years.length - 1 ? stopPlay() : setYear(S.yearIdx + 1)), 950);
});

// ------------------------------------------------------------------ verdict
function renderVerdict() {
  const st = scopeCache;
  const conf = confidence(st);
  const scope = st.whole ? `Whole area · ${fmtArea(st.areaHa)}` : `Selected area · ${fmtArea(st.areaHa)}`;
  const isBase = S.m.baselineYears.includes(st.upto);
  const ranked = [...st.byYear.entries()].filter(([y, n]) => n > 0 && y <= st.upto).sort((a, b) => b[1] - a[1]);
  const peak = ranked[0];
  let say;
  if (isBase) say = `${st.upto} is part of the baseline that everything else is measured against. Move the timeline forward to see change.`;
  else if (st.forestHa < 1) say = "There was no dense forest here in the baseline years, so there is nothing to lose.";
  else if (st.lostHa < 0.5) say = `No lasting canopy loss by ${st.upto} across ${fmtArea(st.forestHa)} of forest.`;
  else {
    const two = ranked.length > 1 && ranked[1][1] > 0.6 * peak[1] ? [ranked[0][0], ranked[1][0]].sort() : null;
    say = `Most of it died in ${two ? `${two[0]} and ${two[1]}` : peak[0]}.`;
    if (st.greenShare > 0.05) {
      const g = st.greenShare;
      const frac = g > 0.45 && g < 0.58 ? "About half" : g >= 0.58 ? `${Math.round(g * 100)}%` : `${Math.round(g * 100)}%`;
      say += ` ${frac} of that ground is green again, mostly grass, shrubs and young trees rather than forest.`;
    }
  }
  $("#verdict").innerHTML = `
    <div class="kicker-row"><span class="kicker">${scope}</span>
      ${st.whole ? `<button class="linkbtn" id="v-select">Select an area</button>` : `<button class="linkbtn" id="v-clear">Use whole area</button>`}</div>
    <p class="q">Where has the forest died, since when, and how sure can we be?</p>
    <div class="big"><span class="num">${isBase ? "0" : Math.round(st.share * 100)}<sup>%</sup></span>
      <span class="of">of the forest had lost its canopy by summer ${st.upto}</span></div>
    <p class="say">${say}</p>
    <div class="stats">
      <div class="stat"><div class="k">Canopy lost</div><div class="v">${fmtArea(st.lostHa)} <small>of ${fmtArea(st.forestHa)}</small></div></div>
      <div class="stat"><div class="k">Peak year</div><div class="v">${peak && !isBase ? `<span style="color:${onsetColour(peak[0])}">${peak[0]}</span> <small>${fmtArea(peak[1] * haPerPx())}</small>` : "–"}</div></div>
      <div class="stat"><div class="k">Green again</div><div class="v">${st.lostHa >= 0.5 ? `${Math.round(st.greenShare * 100)}% <small>of lost area</small>` : "–"}</div></div>
      <div class="stat"><div class="k">Confidence</div><div class="v">${conf.label}${conf.level ? `<span class="meter">${[1, 2, 3].map((k) => `<i class="${k <= conf.level ? "on" : ""}"></i>`).join("")}</span>` : ""}</div></div>
    </div>
    <p class="why">${conf.why}</p>`;
  $("#v-select")?.addEventListener("click", () => { setAreaMode(true); if (innerWidth < 1000) mapEl.scrollIntoView({ behavior: "smooth", block: "center" }); });
  $("#v-clear")?.addEventListener("click", () => { S.area = null; scopeChanged(); });
}

// ------------------------------------------------------------------ spot
function spotModel() {
  const { col, row } = S.point;
  const pts = cellSeries(col, row);
  const summers = summerMedians(pts);
  const bv = S.baseIdx.map((i) => summers[i].v).filter((v) => v === v);
  const base = bv.length ? bv.reduce((a, b) => a + b) / bv.length : NaN;
  const thr = S.m.lossThreshold;
  const onset = base >= 0.55 ? onsetFor((i) => summers[i].v, base, thr) : 0;
  const stateOf = (i) => {
    const y = S.years[i], v = summers[i].v;
    if (onset === 0) return "nf";
    if (S.baseIdx.includes(i)) return "base";
    if (onset > 0 && y >= onset) return v === v && v >= base - thr ? "green" : "lost";
    return "ok";
  };
  return { col, row, pts, summers, base, thr, onset, stateOf };
}
function stateColour(st, onset) {
  return { nf: "#4a5552", base: "#8b9793", ok: HEALTHY, lost: onsetColour(onset), green: onsetColour(onset) + "66" }[st];
}

function renderSpot() {
  if (!S.point) return;
  const M = spotModel();
  const c = S.m.series.cellSizePx;
  const [lat, lon] = pixelLatLon((M.col + 0.5) * c, (M.row + 0.5) * c);
  const cur = M.summers[S.yearIdx];
  const yr = S.years[S.yearIdx];

  let chip;
  if (M.onset === 0) chip = `<span class="chip"><i style="background:#4a5552"></i>Not forest in baseline</span>`;
  else if (M.onset > 0) {
    const green = cur.v === cur.v && cur.v >= M.base - M.thr && yr >= M.onset;
    chip = `<span class="chip"><i style="background:${onsetColour(M.onset)}"></i>${green ? `Lost ${M.onset}, green again` : `Canopy lost ${M.onset}`}</span>`;
  } else chip = `<span class="chip"><i style="background:${HEALTHY}"></i>Intact</span>`;

  let say;
  if (M.onset === 0) say = `This square was not dense forest in ${S.m.baselineYears.join(" and ")} (summer NDVI ${M.base === M.base ? M.base.toFixed(2) : "unknown"}), so it is not tracked for loss.`;
  else if (M.onset > 0) {
    say = `Healthy canopy in the baseline (NDVI ${M.base.toFixed(2)}). It dropped more than ${M.thr} below that in ${M.onset} and stayed down the next summer.`;
    if (cur.v === cur.v && yr > M.onset) say += cur.v >= M.base - M.thr
      ? ` By ${yr} it reads green again (${cur.v.toFixed(2)}). After dieback that is ground vegetation or young trees, not the old forest.`
      : ` In ${yr} it reads ${cur.v.toFixed(2)}.`;
  } else say = `Intact: summer NDVI has stayed within ${M.thr} of its baseline of ${M.base.toFixed(2)}${cur.v === cur.v ? ` (${yr}: ${cur.v.toFixed(2)})` : ""}.`;

  const clear = M.pts.filter((v) => v === v).length;
  $("#spot").innerHTML = `
    <div class="head"><div><div class="kicker">Spot history · 200 m square</div>
      <div class="coords">${lat.toFixed(5)}° N  ${lon.toFixed(5)}° E</div></div>${chip}</div>
    <div class="film" id="film">${S.years.map((y, i) => `<button data-i="${i}" class="${i === S.yearIdx ? "on" : ""}" aria-label="Summer ${y}">
      <canvas width="72" height="72"></canvas><span class="st" style="background:${stateColour(M.stateOf(i), M.onset)}"></span><span class="fy">${String(y).slice(2)}</span></button>`).join("")}</div>
    <div class="chart" id="chart">${chartSvg(M)}</div>
    <p class="say">${say}</p>
    <p class="fine">${clear} of ${M.pts.length} acquisitions were cloud-free here (the strip under the chart). Dots are single views, thick lines are summer medians, the dashed line is the loss threshold. Drag across the chart to move through the years.</p>`;

  // filmstrip: the same 600 m around this square in every summer
  $("#film").querySelectorAll("button").forEach((b, i) => {
    const g = b.querySelector("canvas").getContext("2d");
    const span = c * 3;
    const sx = (M.col + 0.5) * c - span / 2, sy = (M.row + 0.5) * c - span / 2;
    g.imageSmoothingEnabled = false;
    g.drawImage(S.rgbImg[i], sx, sy, span, span, 0, 0, 72, 72);
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1.5;
    g.strokeRect(24, 24, 24, 24);
    b.addEventListener("click", () => { stopPlay(); setYear(i); });
  });
  const svg = $("#chart svg");
  const scrub = (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * CH.W;
    const t = CH.t0 + ((vx - CH.L) / (CH.W - CH.L - CH.R)) * (CH.t1 - CH.t0);
    const y = new Date(Math.min(Math.max(t, CH.t0), CH.t1 - 1)).getUTCFullYear();
    stopPlay();
    setYear(S.years.indexOf(y));
  };
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture(e.pointerId); scrub(e); });
  svg.addEventListener("pointermove", (e) => { if (e.buttons) scrub(e); });
}

const CH = { W: 560, H: 230, L: 30, R: 6, T: 14, B: 40 };
function chartSvg(M) {
  // draw at the real pixel width so the labels stay legible on phones
  const host = $("#spot");
  CH.W = Math.max(280, Math.round((host?.clientWidth || 560) - 32));
  CH.H = Math.round(Math.min(240, Math.max(190, CH.W * 0.45)));
  const { W, H, L, R, T, B } = CH;
  CH.t0 = Date.UTC(S.years[0], 0, 1);
  CH.t1 = Date.UTC(S.years.at(-1) + 1, 0, 1);
  const X = (d) => L + ((d - CH.t0) / (CH.t1 - CH.t0)) * (W - L - R);
  const Y = (v) => T + (1 - (v + 0.1) / 1.1) * (H - T - B);
  const yr = S.years[S.yearIdx];
  const yA = (y) => X(Date.UTC(y, 0, 1));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vegetation index over time for the selected spot">`;
  s += `<rect class="cursor" x="${yA(yr)}" y="${T - 6}" width="${yA(yr + 1) - yA(yr)}" height="${H - T - B + 20}"/>`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  const short = W < 420;
  for (const y of S.years) s += `<text x="${(yA(y) + yA(y + 1)) / 2}" y="${H - 6}" text-anchor="middle"${y === yr ? ' style="fill:var(--ice)"' : ""}>${short ? "’" + String(y).slice(2) : y}</text>`;
  if (M.base === M.base) {
    s += `<rect class="band" x="${L}" width="${W - L - R}" y="${Y(M.base)}" height="${Y(M.base - M.thr) - Y(M.base)}"/>`;
    s += `<line class="bandline" x1="${L}" x2="${W - R}" y1="${Y(M.base - M.thr)}" y2="${Y(M.base - M.thr)}"/>`;
  }
  // acquisition strip: each tick is one satellite pass; bright = cloud-free, dark = lost to cloud
  const sy = H - B + 12;
  M.pts.forEach((v, t) => { s += `<rect class="${v === v ? "clearc" : "gapc"}" x="${X(+S.dates[t]) - 0.6}" y="${sy}" width="1.2" height="7"/>`; });
  M.pts.forEach((v, t) => { if (v === v) s += `<circle class="dot${S.dateYear[t] === yr ? " cur" : ""}" cx="${X(+S.dates[t])}" cy="${Y(Math.max(-0.1, v))}" r="1.9"/>`; });
  M.summers.forEach((m, i) => {
    if (m.v !== m.v) return;
    const col = stateColour(M.stateOf(i), M.onset);
    s += `<path class="med" stroke="${col.length > 7 ? col.slice(0, 7) : col}" stroke-opacity="${col.length > 7 ? 0.55 : 1}" d="M${X(Date.UTC(m.year, 5, 10))},${Y(m.v)}H${X(Date.UTC(m.year, 7, 31))}"/>`;
  });
  if (M.onset > 0) {
    const x = X(Date.UTC(M.onset, 5, 10));
    const col = onsetColour(M.onset);
    s += `<line class="onset" stroke="${col}" x1="${x}" x2="${x}" y1="${T - 4}" y2="${H - B + 4}"/><text x="${x + 5}" y="${T + 4}" style="fill:${col}">loss ${M.onset}</text>`;
  }
  return s + `</svg>`;
}

// ------------------------------------------------------------------ method
function renderMethod() {
  const m = S.m;
  $("#method").innerHTML = `
    <p><strong>Data.</strong> ${m.source}. ${m.series.dates.length} acquisitions from ${m.series.dates[0].slice(0, 4)} to ${m.series.dates.at(-1).slice(0, 4)}, April to October. Cloud, shadow and snow are masked with the scene classification layer. Masked views stay as gaps and are never filled in.</p>
    <p><strong>Summer composites.</strong> Each year is the median of every cloud-free view from 10 June to 31 August. One season per year avoids mistaking leaf fall or spring green-up for loss.</p>
    <p><strong>Loss.</strong> The baseline is the mean of the ${m.baselineYears.join(" and ")} summers. Only pixels with a baseline NDVI of 0.55 or more count as forest. Loss means summer NDVI more than ${m.lossThreshold} below baseline in two consecutive summers with clear views; the first of those is the loss year. A single dry or hazy summer is not enough.</p>
    <p><strong>Green again.</strong> After spruce dies, grass, shrubs and young trees turn the ground green within a few years and NDVI climbs back. That is not the forest returning, so the loss stays on the map, faded, and is counted separately. A shortwave-infrared moisture index or canopy height data would separate young growth from mature canopy.</p>
    <p><strong>Confidence.</strong> High needs at least 15 cloud-free views per 200 m square in both the baseline and the latest two summers, and fewer than 10% of forest pixels missing a summer. Medium needs 6 or more and fewer than 30%. Anything less is Low.</p>
    <p><strong>Limits.</strong> One vegetation index cannot tell bark beetle from felling, storm or drought. 20 m pixels miss single trees. Coordinates are approximate.</p>`;
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try { await load(); }
  catch (err) { $("#verdict").innerHTML = `<p>Could not load the data: ${err.message}. Check that the data folder sits next to this page.</p>`; throw err; }
  $("#title").textContent = "Forest Change Explorer";
  $("#place").textContent = S.m.place;
  $("#eyebrow").textContent = `${S.m.simulated ? "Simulated" : "Sentinel-2"} · ${S.m.pixelSizeM} m · ${S.years[0]}–${S.years.at(-1)} · ${S.m.series.dates.length} passes`;
  $("#sim-badge").hidden = !S.m.simulated;
  renderLegend();
  renderMethod();
  scopeCache = scopeStats();
  renderYears();
  // open on a square that tells the story: lost early, green again by the end
  const { cellSizePx: c, cols, rows } = S.m.series;
  let best = null, bestScore = -1;
  for (let r = Math.floor(rows * 0.3); r < rows * 0.7; r++) for (let cc = Math.floor(cols * 0.3); cc < cols * 0.7; cc++) {
    S.point = { col: cc, row: r };
    const M = spotModel();
    if (M.onset <= 0) continue;
    const last = M.summers.at(-1).v, low = Math.min(...M.summers.slice(2).map((m) => (m.v === m.v ? m.v : 9)));
    // lost in 2020, a deep drop, and green again by the end: the whole story in one square
    const score = 100 - Math.abs(M.onset - 2020) * 20 + (M.base - low) * 60 + (last >= M.base - M.thr ? 25 : 0) + M.pts.filter((v) => v === v).length / 20;
    if (score > bestScore) { bestScore = score; best = { col: cc, row: r }; }
  }
  S.point = best;
  new ResizeObserver(resize).observe(mapEl);
  S.ready = false;
  setYear(S.years.length - 1);
  S.ready = true;
})();
