// Forest Change Explorer: a prototype for answering "where has the forest died, since when,
// and how sure can we be?" from a stack of Sentinel-2 observations.
// No dependencies. Data contract: see pipeline/dataset.py.

const $ = (s) => document.querySelector(s);
const DATA = "data/";

// ------------------------------------------------------------------ colour
// Vegetation index: bare/brown -> pale -> deep green.
const NDVI_STOPS = [
  [-0.2, [78, 62, 48]], [0.15, [140, 114, 82]], [0.35, [205, 190, 130]],
  [0.55, [150, 186, 98]], [0.75, [58, 132, 72]], [1.0, [18, 78, 46]],
];
// Year of loss: early = deep, recent = bright. Sequential so "older" reads as "settled".
const ONSET_COLOURS = ["#5b1f6e", "#8e2a6b", "#c13b5c", "#e2644a", "#f29a3e", "#f7cd58", "#fbf0a2"];

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
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ------------------------------------------------------------------ state
const S = {
  m: null,            // manifest
  years: [],
  yearIdx: 0,
  layer: "rgb",
  compare: false,
  swipe: 0.5,         // compare handle, 0..1 of canvas width
  areaMode: false,
  area: null,         // {x0,y0,x1,y1} in pixel coords, or null = whole scene
  point: null,        // {col,row} cell
  view: { s: 1, x: 0, y: 0 }, // screen = data * s + (x,y)  (CSS px)
  ndvi: [],           // Float32Array per year (NaN = no data)
  rgbImg: [],
  ndviCanvas: [],
  base: null,         // baseline NDVI per pixel
  onset: null,        // Int16Array: 0 = not vegetated at baseline, -1 = no loss, else year
  missing: null,      // Uint8Array: 1 if any year lacks a clear summer view
  series: null,       // Uint8Array [date][row][col]
  dates: [],
  dateYear: [],
  playing: null,
};

// ------------------------------------------------------------------ load
async function loadImage(src) {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  return img;
}

function decodeNdvi(img) {
  const { width: w, height: h } = img;
  const c = new OffscreenCanvasOr(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h).data;
  const e = S.m.ndviEncoding;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = d[i * 4];
    out[i] = v === e.nodata ? NaN : e.min + (v / e.scale) * (e.max - e.min);
  }
  return out;
}

function readGrey(img) {
  const c = OffscreenCanvasOr(img.width, img.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return out;
}

function OffscreenCanvasOr(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function load() {
  const m = await (await fetch(DATA + "manifest.json")).json();
  S.m = m;
  S.years = m.years;
  S.yearIdx = S.years.length - 1;
  const [imgs, ndviImgs, bin] = await Promise.all([
    Promise.all(m.composites.map((c) => loadImage(DATA + c.rgb))),
    Promise.all(m.composites.map((c) => loadImage(DATA + c.ndvi))),
    loadImage(DATA + m.series.file),
  ]);
  S.rgbImg = imgs;
  S.ndvi = ndviImgs.map(decodeNdvi);
  S.series = readGrey(bin); // [date][row][col], one byte per value
  S.dates = m.series.dates.map((d) => new Date(d + "T12:00:00Z"));
  S.dateYear = S.dates.map((d) => d.getUTCFullYear());
  S.ndviCanvas = S.ndvi.map(paintNdvi);
  analyse();
}

// ------------------------------------------------------------------ analysis
// Per pixel: baseline = mean summer NDVI over the baseline years. A pixel has "lost vegetation"
// in a year when its summer NDVI is more than `lossThreshold` below baseline. Onset is the first
// such year after which it never recovers (years without a clear view are skipped, not counted).
function analyse() {
  const { width: w, height: h, baselineYears, lossThreshold: thr } = S.m;
  const n = w * h;
  const baseIdx = baselineYears.map((y) => S.years.indexOf(y)).filter((i) => i >= 0);
  S.base = new Float32Array(n);
  S.onset = new Int16Array(n);
  S.missing = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    let sum = 0, k = 0;
    for (const i of baseIdx) { const v = S.ndvi[i][p]; if (v === v) { sum += v; k++; } }
    const base = k ? sum / k : NaN;
    S.base[p] = base;
    let miss = 0;
    for (let i = 0; i < S.years.length; i++) if (S.ndvi[i][p] !== S.ndvi[i][p]) miss = 1;
    S.missing[p] = miss;
    if (!(base >= 0.55)) { S.onset[p] = 0; continue; } // not forest/dense vegetation at baseline
    S.onset[p] = onsetFor((i) => S.ndvi[i][p], base, thr, baseIdx);
  }
}

// A drop only counts when the next summer with a clear view is also below the threshold,
// so a single dry or hazy summer is not reported as loss. Later regreening (grass, shrubs,
// young trees) does not undo the loss; it is reported separately.
function onsetFor(get, base, thr, baseIdx) {
  const clear = [];
  for (let i = 0; i < S.years.length; i++) {
    if (baseIdx.includes(i)) continue;
    const v = get(i);
    if (v === v) clear.push([S.years[i], v < base - thr]);
  }
  for (let k = 0; k < clear.length - 1; k++) if (clear[k][1] && clear[k + 1][1]) return clear[k][0];
  return -1;
}
const regreened = (p, idx) => { const v = S.ndvi[idx][p]; return v === v && v >= S.base[p] - S.m.lossThreshold; };

// Summer median per year for one 200 m cell, from the scene-level series.
function cellSeries(col, row) {
  const { rows, cols } = S.m.series;
  const e = S.m.ndviEncoding;
  const per = rows * cols;
  const pts = [];
  for (let t = 0; t < S.dates.length; t++) {
    const v = S.series[t * per + row * cols + col];
    pts.push(v === e.nodata ? null : e.min + (v / e.scale) * (e.max - e.min));
  }
  return pts;
}

function summerMedians(pts) {
  const by = new Map(S.years.map((y) => [y, []]));
  pts.forEach((v, t) => {
    if (v == null) return;
    const d = S.dates[t];
    const md = d.getUTCMonth() * 100 + d.getUTCDate();
    if (md >= 510 && md <= 731) by.get(S.dateYear[t])?.push(v); // 10 Jun to 31 Aug (months 0-based)
  });
  const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return S.years.map((y) => ({ year: y, v: med(by.get(y)), n: by.get(y).length }));
}

// ------------------------------------------------------------------ rendering: rasters
function paintNdvi(arr) {
  const { width: w, height: h } = S.m;
  const c = OffscreenCanvasOr(w, h);
  const g = c.getContext("2d");
  const id = g.createImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    const v = arr[p];
    const o = p * 4;
    if (v !== v) { id.data[o] = 60; id.data[o + 1] = 60; id.data[o + 2] = 64; id.data[o + 3] = 255; continue; }
    const [r, gg, b] = lerpStops(NDVI_STOPS, v);
    id.data[o] = r; id.data[o + 1] = gg; id.data[o + 2] = b; id.data[o + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return c;
}

const changeCache = new Map();
function paintChange(uptoYear) {
  if (changeCache.has(uptoYear)) return changeCache.get(uptoYear);
  const { width: w, height: h } = S.m;
  const c = OffscreenCanvasOr(w, h);
  const g = c.getContext("2d");
  // greyscale imagery of the chosen year underneath, so loss sits in context
  g.filter = "grayscale(1) brightness(0.75) contrast(0.9)";
  g.drawImage(S.rgbImg[S.years.indexOf(uptoYear)], 0, 0);
  g.filter = "none";
  const id = g.getImageData(0, 0, w, h);
  const first = S.years.find((y) => !S.m.baselineYears.includes(y));
  const idx = S.years.indexOf(uptoYear);
  for (let p = 0; p < w * h; p++) {
    const y = S.onset[p];
    if (y > 0 && y <= uptoYear) {
      const [r, gg, b] = hex(ONSET_COLOURS[Math.min(y - first, ONSET_COLOURS.length - 1)]);
      const o = p * 4;
      // regreened since: keep the loss year's colour but fade it into the imagery
      const a = regreened(p, idx) ? 0.42 : 1;
      id.data[o] = id.data[o] * (1 - a) + r * a;
      id.data[o + 1] = id.data[o + 1] * (1 - a) + gg * a;
      id.data[o + 2] = id.data[o + 2] * (1 - a) + b * a;
    }
  }
  g.putImageData(id, 0, 0);
  changeCache.set(uptoYear, c);
  return c;
}

function layerSource(layer, idx) {
  if (layer === "rgb") return S.rgbImg[idx];
  if (layer === "ndvi") return S.ndviCanvas[idx];
  return paintChange(S.years[idx]);
}

// ------------------------------------------------------------------ map canvas
const mapEl = $("#map");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let dpr = 1;

function resize() {
  const r = mapEl.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  if (!S.fitted) fit();
  draw();
}

function fit() {
  const r = mapEl.getBoundingClientRect();
  const s = Math.min(r.width / S.m.width, r.height / S.m.height);
  S.view = { s, x: (r.width - S.m.width * s) / 2, y: (r.height - S.m.height * s) / 2 };
  S.fitScale = s;
  S.fitted = true;
  mapEl.classList.remove("zoomed");
}

function clampView() {
  const r = mapEl.getBoundingClientRect();
  const v = S.view;
  v.s = Math.min(Math.max(v.s, S.fitScale), S.fitScale * 16);
  const W = S.m.width * v.s, H = S.m.height * v.s;
  v.x = W <= r.width ? (r.width - W) / 2 : Math.min(0, Math.max(r.width - W, v.x));
  v.y = H <= r.height ? (r.height - H) / 2 : Math.min(0, Math.max(r.height - H, v.y));
  mapEl.classList.toggle("zoomed", v.s > S.fitScale * 1.02);
}

const toData = (sx, sy) => [(sx - S.view.x) / S.view.s, (sy - S.view.y) / S.view.s];

function draw() {
  if (!S.m) return;
  const { s, x, y } = S.view;
  const W = canvas.width / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, canvas.height / dpr);
  ctx.imageSmoothingEnabled = s < 3;

  const idx = S.yearIdx;
  const drawLayer = (src) => ctx.drawImage(src, x, y, S.m.width * s, S.m.height * s);
  drawLayer(layerSource(S.layer, idx));

  if (S.compare) {
    const baseIdx = 0;
    const cut = S.swipe * W;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, cut, canvas.height / dpr);
    ctx.clip();
    drawLayer(layerSource(S.layer === "change" ? "rgb" : S.layer, baseIdx));
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.fillRect(cut - 1, 0, 2, canvas.height / dpr);
    ctx.beginPath();
    ctx.arc(cut, canvas.height / dpr / 2, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.font = "600 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("‹ ›", cut, canvas.height / dpr / 2);
  }

  // selected area
  if (S.area) {
    const a = normArea(S.area);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + a.x0 * s, y + a.y0 * s, (a.x1 - a.x0) * s, (a.y1 - a.y0) * s);
    ctx.setLineDash([]);
  }

  // inspected cell
  if (S.point) {
    const c = S.m.series.cellSizePx;
    const px = x + S.point.col * c * s, py = y + S.point.row * c * s, sz = c * s;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 4;
    ctx.strokeRect(px, py, sz, sz);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, sz, sz);
  }
  drawScale();
}

function drawScale() {
  const mPerCss = S.m.pixelSizeM / S.view.s;
  const target = 90 * mPerCss;
  const nice = [100, 200, 250, 500, 1000, 2000, 2500, 5000].find((n) => n >= target * 0.6) || 5000;
  $("#scale .scale-bar").style.width = `${nice / mPerCss}px`;
  $("#scale .scale-text").textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
}

// ------------------------------------------------------------------ map interaction
const pointers = new Map();
let gesture = null;

mapEl.addEventListener("pointerdown", (e) => {
  mapEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  const W = mapEl.clientWidth;
  if (pointers.size === 1) {
    if (S.compare && Math.abs(e.offsetX - S.swipe * W) < 24) gesture = { type: "swipe" };
    else if (S.areaMode) {
      const [dx, dy] = toData(e.offsetX, e.offsetY);
      S.area = { x0: dx, y0: dy, x1: dx, y1: dy };
      gesture = { type: "area" };
    } else gesture = { type: "pan", sx: e.offsetX, sy: e.offsetY, vx: S.view.x, vy: S.view.y, t: performance.now(), moved: 0 };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...S.view } };
  }
});

mapEl.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (!gesture) return;
  if (gesture.type === "swipe") {
    S.swipe = Math.min(0.98, Math.max(0.02, e.offsetX / mapEl.clientWidth));
  } else if (gesture.type === "area") {
    const [dx, dy] = toData(e.offsetX, e.offsetY);
    S.area.x1 = dx; S.area.y1 = dy;
  } else if (gesture.type === "pan") {
    gesture.moved = Math.max(gesture.moved, Math.hypot(e.offsetX - gesture.sx, e.offsetY - gesture.sy));
    S.view.x = gesture.vx + e.offsetX - gesture.sx;
    S.view.y = gesture.vy + e.offsetY - gesture.sy;
    clampView();
  } else if (gesture.type === "pinch" && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    zoomAt(gesture.cx, gesture.cy, (gesture.view.s * d) / gesture.d, gesture.view);
  }
  draw();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture?.type === "pan" && gesture.moved < 6 && performance.now() - gesture.t < 500) inspect(e.offsetX, e.offsetY);
  if (gesture?.type === "area") {
    const a = normArea(S.area);
    if ((a.x1 - a.x0) * (a.y1 - a.y0) < 25) S.area = null; // a tap, not a drag
    setAreaMode(false);
    renderVerdict();
  }
  gesture = null;
  draw();
}
mapEl.addEventListener("pointerup", endPointer);
mapEl.addEventListener("pointercancel", endPointer);

mapEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, S.view.s * Math.exp(-e.deltaY * 0.0015), S.view);
  draw();
}, { passive: false });

function zoomAt(cx, cy, newS, from) {
  const [dx, dy] = [(cx - from.x) / from.s, (cy - from.y) / from.s];
  S.view.s = newS;
  S.view.x = cx - dx * newS;
  S.view.y = cy - dy * newS;
  clampView();
}

$("#btn-fit").addEventListener("click", () => { fit(); draw(); });

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
  $("#map-hint").style.opacity = 0;
  renderPoint();
  draw();
  if (window.innerWidth < 900) $("#point").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ------------------------------------------------------------------ controls
function setLayer(l) {
  S.layer = l;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.layer === l)));
  renderLegend();
  renderCompareLabels();
  draw();
}
document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => setLayer(b.dataset.layer)));

$("#btn-compare").addEventListener("click", () => {
  S.compare = !S.compare;
  $("#btn-compare").setAttribute("aria-pressed", String(S.compare));
  if (S.compare && S.yearIdx === 0) setYear(S.years.length - 1);
  renderCompareLabels();
  draw();
});

function setAreaMode(on) {
  S.areaMode = on;
  $("#btn-area").setAttribute("aria-pressed", String(on));
  $("#btn-area").textContent = on ? "Drag on map" : "Select area";
}
$("#btn-area").addEventListener("click", () => setAreaMode(!S.areaMode));

function renderCompareLabels() {
  const show = S.compare;
  $("#cmp-left").hidden = $("#cmp-right").hidden = !show;
  if (!show) return;
  const name = { rgb: "Imagery", ndvi: "Vegetation", change: "Loss" };
  $("#cmp-left").textContent = `${S.years[0]} ${S.layer === "change" ? "Imagery" : name[S.layer]}`;
  $("#cmp-right").textContent = `${S.years[S.yearIdx]} ${name[S.layer]}`;
}

// ------------------------------------------------------------------ timeline
function renderYears() {
  const el = $("#years");
  const maxClear = Math.max(...S.m.composites.map((c) => c.clearObs), 1);
  el.innerHTML = S.m.composites.map((c, i) => `
    <div class="year${S.m.baselineYears.includes(c.year) ? " base" : ""}" data-i="${i}" title="${c.year}: ${c.clearObs} cloud-free views per pixel (median)">
      <span class="q" style="height:${Math.max(3, (22 * c.clearObs) / maxClear)}px"></span>
      <span>${String(c.year).slice(2)}</span>
    </div>`).join("");
  const pick = (e) => {
    const r = el.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * S.years.length);
    setYear(Math.max(0, Math.min(S.years.length - 1, i)));
  };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); stopPlay(); pick(e); });
  el.addEventListener("pointermove", (e) => { if (e.buttons) pick(e); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setYear(Math.max(0, S.yearIdx - 1)); e.preventDefault(); }
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { setYear(Math.min(S.years.length - 1, S.yearIdx + 1)); e.preventDefault(); }
  });
}

function setYear(i) {
  if (i === S.yearIdx && S.rendered) return;
  S.yearIdx = i;
  S.rendered = true;
  document.querySelectorAll(".year").forEach((el, k) => el.classList.toggle("active", k === i));
  $("#years").setAttribute("aria-valuenow", S.years[i]);
  $("#years").setAttribute("aria-valuetext", `Summer ${S.years[i]}`);
  renderCompareLabels();
  renderVerdict();
  if (S.point) renderPoint();
  draw();
}

function stopPlay() {
  clearInterval(S.playing);
  S.playing = null;
  $("#btn-play").classList.remove("playing");
}
$("#btn-play").addEventListener("click", () => {
  if (S.playing) return stopPlay();
  $("#btn-play").classList.add("playing");
  if (S.yearIdx === S.years.length - 1) setYear(0);
  S.playing = setInterval(() => {
    if (S.yearIdx >= S.years.length - 1) return stopPlay();
    setYear(S.yearIdx + 1);
  }, 900);
});

// ------------------------------------------------------------------ legend
function renderLegend() {
  const el = $("#legend");
  if (S.layer === "rgb") { el.innerHTML = "Summer true colour"; return; }
  if (S.layer === "ndvi") {
    const ramp = NDVI_STOPS.map(([v, c]) => `rgb(${c}) ${((v + 0.2) / 1.2) * 100}%`).join(",");
    el.innerHTML = `Vegetation (NDVI)<div class="ramp" style="background:linear-gradient(90deg,${ramp})"></div><div class="ends"><span>bare</span><span>dense</span></div>`;
    return;
  }
  const first = S.years.find((y) => !S.m.baselineYears.includes(y));
  const ys = S.years.filter((y) => y >= first);
  el.innerHTML = `Canopy loss since ${S.m.baselineYears.join("–")}, by first year (faded = green again)<div class="chips">${ys.map((y, i) => `<span class="chip"><i class="sw" style="background:${ONSET_COLOURS[Math.min(i, ONSET_COLOURS.length - 1)]}"></i>${String(y).slice(2)}</span>`).join("")}</div>`;
}

// ------------------------------------------------------------------ verdict
function areaStats() {
  const { width: w, height: h } = S.m;
  const a = S.area ? normArea(S.area) : { x0: 0, y0: 0, x1: w, y1: h };
  const upto = S.years[S.yearIdx];
  const haPerPx = (S.m.pixelSizeM ** 2) / 10000;
  let forest = 0, lost = 0, missing = 0, regreen = 0;
  const idx = S.yearIdx;
  const byYear = new Map(S.years.map((y) => [y, 0]));
  for (let yy = a.y0; yy < a.y1; yy++) for (let xx = a.x0; xx < a.x1; xx++) {
    const p = yy * w + xx;
    const o = S.onset[p];
    if (o === 0) continue;
    forest++;
    if (S.missing[p]) missing++;
    if (o > 0 && o <= upto) { lost++; byYear.set(o, byYear.get(o) + 1); if (regreened(p, idx)) regreen++; }
  }
  // Evidence: clear observations per cell in the baseline window and in the two years up to `upto`.
  const { cellSizePx: c, rows, cols } = S.m.series;
  const per = rows * cols;
  const nod = S.m.ndviEncoding.nodata;
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
  return {
    a, upto, forestHa: forest * haPerPx, lostHa: lost * haPerPx, share: forest ? lost / forest : 0,
    missingShare: forest ? missing / forest : 0, byYear, haPerPx, regreenShare: lost ? regreen / lost : 0,
    before: cells ? before / cells : 0, after: cells ? after / cells : 0, whole: !S.area,
  };
}

function confidence(st) {
  const minObs = Math.min(st.before, st.after);
  let level = minObs >= 15 && st.missingShare < 0.1 ? 3 : minObs >= 6 && st.missingShare < 0.3 ? 2 : 1;
  if (S.m.baselineYears.includes(st.upto)) level = 0;
  const label = ["Not applicable", "Low", "Medium", "High"][level];
  const why = level === 0
    ? "This is a baseline year, so there is nothing to compare yet."
    : `Based on about ${Math.round(st.before)} cloud-free views per 200 m cell in ${S.m.baselineYears.join(" and ")} and ${Math.round(st.after)} in the last two summers up to ${st.upto}. ` +
      (st.missingShare > 0.02 ? `${Math.round(st.missingShare * 100)}% of the forest had at least one summer with no clear view, so its loss year may be later than shown.` : "Every forest pixel had a clear view in every summer.");
  return { level, label, why };
}

const fmtHa = (ha) => ha >= 1000 ? `${(ha / 100).toFixed(0)} km²` : `${Math.round(ha).toLocaleString("en-GB")} ha`;

function renderVerdict() {
  if (!S.m) return;
  const st = areaStats();
  const conf = confidence(st);
  const el = $("#verdict");
  const scope = st.whole ? "Whole area" : "Selected area";
  let headline;
  if (S.m.baselineYears.includes(st.upto)) {
    headline = `${st.upto} is part of the baseline. Move the timeline forward to see change.`;
  } else if (st.forestHa < 1) {
    headline = "There was no dense vegetation here at the baseline, so there is nothing to lose.";
  } else if (st.lostHa < 0.5) {
    headline = `No lasting vegetation loss by ${st.upto} across ${fmtHa(st.forestHa)} of forest.`;
  } else {
    const peak = [...st.byYear.entries()].sort((a, b) => b[1] - a[1])[0];
    const sorted = [...st.byYear.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const top2 = sorted.slice(0, 2).map(([y]) => y).sort();
    const when = top2.length > 1 && sorted[1][1] > 0.4 * peak[1] ? `${top2[0]} and ${top2[1]}` : `${peak[0]}`;
    headline = `${Math.round(st.share * 100)}% of the forest (${fmtHa(st.lostHa)}) had lost its canopy by ${st.upto}. Most of it went in ${when}.`;
    if (st.regreenShare > 0.05) headline += ` <span class="sub">${Math.round(st.regreenShare * 100)}% of that area looks green again in ${st.upto}, most likely grass, shrubs or young trees rather than recovered forest. It is shown faded on the map.</span>`;
  }
  const first = S.years.find((y) => !S.m.baselineYears.includes(y));
  const ys = S.years.filter((y) => y >= first);
  const max = Math.max(...ys.map((y) => st.byYear.get(y)), 1);
  el.innerHTML = `
    <div class="scope"><span>${scope}, ${fmtHa(((st.a.x1 - st.a.x0) * (st.a.y1 - st.a.y0)) * st.haPerPx)}</span>
      ${st.whole ? `<button id="v-select">Select an area</button>` : `<button id="v-clear">Use whole area</button>`}</div>
    <p class="headline">${headline}</p>
    <div class="onset-bars" role="group" aria-label="Hectares lost by first year of loss">
      ${ys.map((y, i) => {
        const n = st.byYear.get(y);
        const later = y > st.upto;
        return `<button data-y="${y}" class="${y === st.upto ? "active" : ""}" title="${y}: ${fmtHa(n * st.haPerPx)}">
          <span class="bar" style="height:${later ? 2 : Math.max(2, (60 * n) / max)}px;background:${later ? "var(--chart-gap)" : ONSET_COLOURS[Math.min(i, ONSET_COLOURS.length - 1)]}"></span>
          <span>${String(y).slice(2)}</span></button>`;
      }).join("")}
    </div>
    <p class="onset-cap">Canopy lost, by the first summer it was detected (tap a bar to jump there)</p>
    <div class="conf">Confidence: ${conf.label}<span class="dots">${[1, 2, 3].map((k) => `<i class="${k <= conf.level ? "on" : ""}"></i>`).join("")}</span></div>
    <p class="conf-why">${conf.why}</p>`;
  el.querySelectorAll(".onset-bars button").forEach((b) => b.addEventListener("click", () => { stopPlay(); setYear(S.years.indexOf(+b.dataset.y)); }));
  el.querySelector("#v-select")?.addEventListener("click", () => { setAreaMode(true); $("#map").scrollIntoView({ behavior: "smooth", block: "center" }); });
  el.querySelector("#v-clear")?.addEventListener("click", () => { S.area = null; renderVerdict(); draw(); });
}

// ------------------------------------------------------------------ point chart
function cellLatLon(col, row) {
  const [w, s, e, n] = S.m.bbox;
  const c = S.m.series.cellSizePx;
  const fx = ((col + 0.5) * c) / S.m.width, fy = ((row + 0.5) * c) / S.m.height;
  return [n - fy * (n - s), w + fx * (e - w)];
}

function renderPoint() {
  if (!S.point) return;
  const { col, row } = S.point;
  const pts = cellSeries(col, row);
  const summers = summerMedians(pts);
  const baseIdx = S.m.baselineYears.map((y) => S.years.indexOf(y));
  const bv = baseIdx.map((i) => summers[i].v).filter((v) => v === v);
  const base = bv.length ? bv.reduce((a, b) => a + b) / bv.length : NaN;
  const thr = S.m.lossThreshold;
  const onset = base >= 0.55 ? onsetFor((i) => summers[i].v, base, thr, baseIdx) : 0;

  const [lat, lon] = cellLatLon(col, row);
  $("#point-coords").textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
  const clear = pts.filter((v) => v != null).length;
  $("#point-title").textContent = "Spot history, 200 m square";

  // chart geometry
  const W = 560, H = 210, L = 30, R = 8, T = 14, B = 26;
  const t0 = Date.UTC(S.years[0], 0, 1), t1 = Date.UTC(S.years.at(-1) + 1, 0, 1);
  const X = (d) => L + ((d - t0) / (t1 - t0)) * (W - L - R);
  const Y = (v) => T + (1 - (v + 0.2) / 1.2) * (H - T - B);
  const yr = S.years[S.yearIdx];
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vegetation index over time for the selected spot">`;
  svg += `<rect class="cursor" x="${X(Date.UTC(yr, 0, 1))}" y="${T}" width="${X(Date.UTC(yr + 1, 0, 1)) - X(Date.UTC(yr, 0, 1))}" height="${H - T - B}"/>`;
  for (const v of [0, 0.4, 0.8]) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  for (const y of S.years) svg += `<text x="${(X(Date.UTC(y, 0, 1)) + X(Date.UTC(y + 1, 0, 1))) / 2}" y="${H - 8}" text-anchor="middle">${y}</text>`;
  if (base === base) svg += `<rect class="band" x="${L}" width="${W - L - R}" y="${Y(base)}" height="${Y(base - thr) - Y(base)}"/>`;
  // cloud gaps: ticks along the bottom
  pts.forEach((v, t) => { if (v == null) { const x = X(+S.dates[t]); svg += `<line class="gap" x1="${x}" x2="${x}" y1="${H - B}" y2="${H - B - 5}"/>`; } });
  // observations
  pts.forEach((v, t) => { if (v != null) svg += `<circle class="dot${S.dateYear[t] === yr ? " cur" : ""}" cx="${X(+S.dates[t])}" cy="${Y(v)}" r="2.1"/>`; });
  // summer medians as a step line
  let path = "";
  summers.forEach((s) => { if (s.v === s.v) { const xa = X(Date.UTC(s.year, 5, 10)), xb = X(Date.UTC(s.year, 7, 31)); path += `M${xa},${Y(s.v)}H${xb}`; } });
  svg += `<path class="summer" d="${path}"/>`;
  if (onset > 0) {
    const x = X(Date.UTC(onset, 5, 10));
    svg += `<line class="onset" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/><text class="onset-label" x="${x + 4}" y="${T + 8}">loss from ${onset}</text>`;
  }
  svg += `</svg>`;
  const chart = $("#chart");
  chart.innerHTML = svg;

  // scrub the chart to move the map through time
  const svgEl = chart.querySelector("svg");
  const scrub = (e) => {
    const r = svgEl.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const d = t0 + ((vx - L) / (W - L - R)) * (t1 - t0);
    const y = new Date(Math.min(Math.max(d, t0), t1 - 1)).getUTCFullYear();
    stopPlay();
    setYear(S.years.indexOf(y));
  };
  svgEl.addEventListener("pointerdown", (e) => { svgEl.setPointerCapture(e.pointerId); scrub(e); });
  svgEl.addEventListener("pointermove", (e) => { if (e.buttons) scrub(e); });

  // plain-language reading
  const cur = summers[S.yearIdx];
  let text;
  if (!(base >= 0.55)) text = `This square was not dense vegetation in ${S.m.baselineYears.join("–")} (summer NDVI ${base === base ? base.toFixed(2) : "unknown"}), so it is not tracked for forest loss.`;
  else if (onset > 0) {
    const green = cur.v === cur.v && cur.v >= base - thr && cur.year >= onset;
    text = `Healthy in the baseline (NDVI ${base.toFixed(2)}). Summer NDVI fell more than ${thr} below that in ${onset} and stayed down the next summer, so this counts as canopy loss.` +
      (green ? ` By ${cur.year} it is green again (${cur.v.toFixed(2)}), which after dieback usually means ground vegetation or young trees, not the old forest.` : cur.v === cur.v ? ` In ${cur.year} it was ${cur.v.toFixed(2)}.` : "");
  }
  else text = `Stable: summer NDVI has stayed within ${thr} of its baseline of ${base.toFixed(2)}${cur.v === cur.v ? ` (${cur.year}: ${cur.v.toFixed(2)})` : ""}.`;
  $("#point-text").innerHTML = `${text} <span class="muted">${clear} cloud-free views out of ${pts.length} acquisitions. Grey ticks mark the ones lost to cloud. Dots are single views; the dark lines are summer medians; the shaded band is the baseline minus the loss threshold. Drag across the chart to move the map.</span>`;
}

// ------------------------------------------------------------------ method
function renderMethod() {
  const m = S.m;
  $("#method").innerHTML = `
    <p><strong>Data.</strong> ${m.source}. ${m.series.dates.length} acquisitions from ${m.series.dates[0].slice(0, 4)} to ${m.series.dates.at(-1).slice(0, 4)}, April to October. Clouds, shadows and snow are masked using the scene classification layer; masked views are shown as gaps, never filled in.</p>
    <p><strong>Summer composites.</strong> For each year, the median of every cloud-free view between 10 June and 31 August. Using one season avoids confusing autumn leaf fall or spring green-up with loss.</p>
    <p><strong>Loss rule.</strong> Baseline is the mean of the ${m.baselineYears.join(" and ")} summers. Only pixels with baseline NDVI of at least 0.55 count as forest. A pixel shows canopy loss when its summer NDVI is more than ${m.lossThreshold} below baseline in two consecutive summers with clear views; the first of those is its loss year. One bad summer (drought, haze) is not enough. This means the latest year cannot be confirmed yet.</p>
    <p><strong>Regreening.</strong> After spruce dies, grass, shrubs and young birch or spruce turn the ground green again within a few years, and NDVI climbs back. That does not mean the forest is back, so regreened loss stays on the map, faded, and is reported separately. A moisture or shortwave-infrared index (or canopy height data) would separate young growth from mature forest better; that is the next thing I would add.</p>
    <p><strong>Confidence.</strong> High needs at least 15 clear views per 200 m cell both in the baseline and in the latest two summers, with under 10% of forest pixels missing any summer. Medium needs 6 or more and under 30%. Anything else is Low.</p>
    <p><strong>Limits.</strong> A threshold on one index cannot tell bark beetle from felling, storm damage or drought stress. Field checks or very high-resolution imagery would confirm the cause. 20 m pixels miss single trees.</p>`;
}

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    await load();
  } catch (err) {
    $("#verdict").innerHTML = `<p>Could not load the data (${err.message}).</p>`;
    throw err;
  }
  $("#title").textContent = S.m.title;
  $("#place").textContent = S.m.place;
  $("#sim-badge").hidden = !S.m.simulated;
  renderYears();
  renderLegend();
  renderMethod();
  new ResizeObserver(resize).observe(mapEl);
  setYear(S.years.length - 1);
  setLayer("change");
  // Start on a spot that tells the story: the cell with the most loss at the latest year.
  const { cellSizePx: c, cols, rows } = S.m.series;
  let best = null, bestScore = -1;
  for (let r = Math.floor(rows * 0.25); r < rows * 0.75; r++) for (let cc = Math.floor(cols * 0.25); cc < cols * 0.75; cc++) {
    const p = (r * c + c / 2) * S.m.width + cc * c + c / 2;
    const o = S.onset[p];
    const score = o > 0 ? 100 - Math.abs(o - 2020) * 10 + (S.missing[p] ? 0 : 5) : -1;
    if (score > bestScore) { bestScore = score; best = { col: cc, row: r }; }
  }
  if (best) { S.point = best; renderPoint(); draw(); }
})();
