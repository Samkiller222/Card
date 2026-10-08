const API = "https://api.tcgdex.net/v2/ja";
const SETS_KEY = "jp-card-scanner-sets";
const SETS_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const HISTORY_KEY = "jp-card-scanner-history";
const HISTORY_LIMIT = 40;
const PHOTO_MAX_SIDE = 2000;
const CARD_RATIO = 63 / 88; // width / height of a Pokémon card

const $ = (id) => document.getElementById(id);
const photo = $("photo");
const photoCtx = photo.getContext("2d", { willReadFrequently: true });

let currentFile = null; // the photo, kept for "Ask Claude"
let setsPromise = null;
let workerPromise = null;
const cardCache = new Map(); // "SV2a-205" -> card JSON, or null when it doesn't exist

// ---------- small helpers ----------

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function money(n, cur) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: cur === "JPY" ? 0 : 2 }).format(n);
}
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
function setStatus(text, busy = true) {
  $("status-text").textContent = text;
  $("status").classList.toggle("done", !busy);
}
function showError(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a timeout and two retries, so a patchy connection doesn't fail a scan
async function fetchRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (res.status < 500) return res; // 404 is an answer, not a failure
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    await sleep(600 * (i + 1));
  }
  throw lastErr;
}

// ---------- TCGdex data ----------

function loadSets() {
  if (setsPromise) return setsPromise;
  const cached = readStore(SETS_KEY, null);
  if (cached && Date.now() - cached.at < SETS_MAX_AGE && Array.isArray(cached.sets) && cached.sets.length) {
    setsPromise = Promise.resolve(cached.sets);
    return setsPromise;
  }
  setsPromise = fetchRetry(`${API}/sets`)
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((sets) => {
      const slim = sets.map((s) => ({ id: s.id, name: s.name, cardCount: s.cardCount }));
      writeStore(SETS_KEY, { at: Date.now(), sets: slim });
      return slim;
    })
    .catch(() => {
      setsPromise = null; // try again next time
      return cached ? cached.sets : [];
    });
  return setsPromise;
}

async function normaliseSetId(setInput) {
  const sets = await loadSets();
  const set = sets.find((s) => s.id.toLowerCase() === String(setInput).toLowerCase());
  return set ? set.id : setInput;
}

// Returns the card, or null if TCGdex has no such card. Throws on network failure.
async function fetchCard(setInput, number) {
  const setId = await normaliseSetId(setInput);
  const key = `${setId}-${String(number).replace(/^0+(?=\d)/, "")}`.toLowerCase();
  if (cardCache.has(key)) return cardCache.get(key);
  let card = null;
  for (const localId of CardReader.localIds(number)) {
    const res = await fetchRetry(`${API}/cards/${encodeURIComponent(`${setId}-${localId}`)}`);
    if (res.ok) { card = await res.json(); break; }
  }
  cardCache.set(key, card);
  return card;
}

// Check readings against the database.
// Readings where the set code was read are tried in order; the first real card wins.
// Readings based only on the card count ("070/066" fits 8 sets) are checked all at once:
// one real card wins, several become a choice for the person.
// Returns { card, reading } | { choices: [card] } | { offline, reading } | null.
async function resolveReadings(readings, { allowChoices = true } = {}) {
  try {
    for (const r of readings.filter((r) => r.via !== "total").slice(0, 4)) {
      const card = await fetchCard(r.setId, r.number);
      if (card) return { card, reading: r };
    }
    const weak = readings.filter((r) => r.via === "total").slice(0, 16);
    if (!weak.length) return null;
    const cards = (await Promise.all(weak.map((r) => fetchCard(r.setId, r.number)))).filter(Boolean);
    if (cards.length === 1) return { card: cards[0], reading: weak[0] };
    if (cards.length > 1 && allowChoices) return { choices: cards };
    return null;
  } catch {
    return { offline: true, reading: readings[0] };
  }
}

// ---------- text reading (OCR) ----------

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // A failed download is reported through errorHandler, not by rejecting createWorker.
      const worker = await new Promise((resolve, reject) => {
        Tesseract.createWorker("eng", 1, {
          logger: (m) => {
            if (m.status && m.status.startsWith("loading") && typeof m.progress === "number" && m.progress < 1) {
              setStatus(`Downloading the text reader (first time only)… ${Math.round(m.progress * 100)}%`);
            }
          },
          errorHandler: (err) => {
            workerPromise = null;
            reject(err);
          },
        }).then(resolve, reject);
      });
      await worker.setParameters({
        tessedit_pageseg_mode: "11", // sparse text: find small text anywhere
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/-. ",
      });
      return worker;
    })().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Otsu's method: the grey level that best splits text from background.
function otsu(grey) {
  const hist = new Array(256).fill(0);
  for (const g of grey) hist[g | 0]++;
  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// Copy a region of `src`, scaled up and cleaned for reading.
// mode: "stretch" (contrast), "binary" (black text on white), "invert" (white text, e.g. full-art cards)
function prepareRegion(src, sx, sy, sw, sh, targetWidth, mode = "stretch", rotate = 0) {
  const scale = Math.max(1, Math.min(4, targetWidth / sw));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  const c = document.createElement("canvas");
  const sideways = rotate === 90 || rotate === -90;
  c.width = sideways ? h : w;
  c.height = sideways ? w : h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const grey = new Uint8ClampedArray(d.length / 4);
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    grey[j] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const t = mode === "stretch" ? 0 : otsu(grey);
  const range = Math.max(1, max - min);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v;
    if (mode === "stretch") v = ((grey[j] - min) / range) * 255;
    else if (mode === "binary") v = grey[j] > t ? 255 : 0;
    else v = grey[j] > t ? 0 : 255; // invert: light text becomes dark
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  c.meta = { src, sx, sy, scale, rotate };
  return c;
}

async function readText(canvas, psm) {
  const worker = await getWorker();
  if (psm) await worker.setParameters({ tessedit_pageseg_mode: psm });
  try {
    const { data } = await worker.recognize(canvas);
    return { text: data.text || "", words: data.words || [] };
  } finally {
    if (psm) await worker.setParameters({ tessedit_pageseg_mode: "11" });
  }
}

// Find the "070/066" word and return the area around it (with room for the
// set code to its left) in the source image's pixels.
function numberArea(words, canvas, number) {
  const m = canvas.meta;
  if (!m || m.rotate) return null;
  // the word holding the number we read, e.g. "070/066" for number "070"
  const digitsOnly = (t) => t.replace(/[OoDQ]/g, "0").replace(/[Il|]/g, "1");
  const word = words.find((w) => {
    const t = digitsOnly(w.text);
    return /\d{1,3}\s*[\/⁄]\s*\d{2,3}/.test(t) && (!number || t.includes(number));
  });
  if (!word) return null;
  const b = word.bbox;
  const x0 = m.sx + b.x0 / m.scale, x1 = m.sx + b.x1 / m.scale;
  const y0 = m.sy + b.y0 / m.scale, y1 = m.sy + b.y1 / m.scale;
  const w = x1 - x0, h = y1 - y0;
  const sx = Math.max(0, x0 - w * 1.4), sy = Math.max(0, y0 - h * 1.2);
  const ex = Math.min(m.src.width, x1 + w * 0.8), ey = Math.min(m.src.height, y1 + h * 1.2);
  return { src: m.src, sx, sy, sw: ex - sx, sh: ey - sy, textHeight: h, word: { x0, y0, x1, y1 } };
}

// The set code (e.g. "sv4M", often inside a printed box) sits just left of the number.
// Read that patch alone as a single word.
function codePasses(area) {
  const { x0, y0, x1, y1 } = area.word;
  const w = x1 - x0, h = y1 - y0;
  const sx = Math.max(0, x0 - w * 0.95), sy = Math.max(0, y0 - h * 0.35);
  const sw = w * 0.9, sh = h * 1.7;
  return ["binary", "stretch"].map((mode) => {
    const make = () => prepareRegion(area.src, sx, sy, sw, sh, sw * 6, mode);
    make.psm = "8";
    return make;
  });
}

function zoomPasses(area) {
  // scale so the text is about 48px tall, which Tesseract reads best
  const target = (area.sw * 48) / Math.max(4, area.textHeight);
  return ["binary", "stretch", "invert"].map((mode) => () =>
    prepareRegion(area.src, area.sx, area.sy, area.sw, area.sh, Math.min(3000, target), mode));
}

// Run reading passes until one gives a code that matches a real card.
// Returns { card, reading } | { offline, reading } | { partial } | null.
async function readCard(passes, onPass) {
  const sets = await loadSets();
  let fallback = null;
  let numberOnly = null; // readings where only the number was read
  let zoomed = false;
  const texts = []; // everything read, to help pick the set when its code was only partly read
  const queue = passes.map((make) => ({ make, zoom: false }));
  for (let i = 0; i < queue.length; i++) {
    onPass && onPass(i, queue[i].zoom);
    const canvas = queue[i].make();
    const { text, words } = await readText(canvas, queue[i].make.psm);
    texts.push(text);
    const list = CardReader.readings(text, sets);
    if (list.some((r) => r.via !== "total")) {
      const hit = await resolveReadings(list, { allowChoices: false });
      if (hit) return hit;
    }
    if (list.length && !numberOnly) numberOnly = list;
    // Found the number but not the set: zoom in on it next, to read the set code beside it.
    if (list.length && !zoomed) {
      const area = numberArea(words, canvas, list[0].number);
      if (area) {
        zoomed = true;
        queue.splice(i + 1, 0, ...[...codePasses(area), ...zoomPasses(area)].map((make) => ({ make, zoom: true })));
      }
    }
    if (!list.length && !fallback) {
      const p = CardReader.parseCardText(text, sets);
      if (p && p.number) fallback = { partial: { setId: p.setId, number: p.number }, candidates: p.candidates };
    }
  }
  if (numberOnly) {
    const hit = await resolveReadings(CardReader.rankByHint(numberOnly, texts));
    if (hit) return hit;
    return { partial: numberOnly[0] };
  }
  return fallback;
}

// ---------- photo handling ----------

async function loadPhoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
  photo.width = Math.round(bmp.width * scale);
  photo.height = Math.round(bmp.height * scale);
  photoCtx.drawImage(bmp, 0, 0, photo.width, photo.height);
  bmp.close();
}

function photoPasses() {
  const w = photo.width, h = photo.height;
  const strip = [0, h * 0.8, w, h * 0.2];
  const corner = [0, h * 0.85, w * 0.6, h * 0.15];
  const passes = [
    () => prepareRegion(photo, ...strip, 2000, "stretch"),
    () => prepareRegion(photo, ...strip, 2000, "binary"),
    () => prepareRegion(photo, ...strip, 2000, "invert"),
    () => prepareRegion(photo, 0, 0, w, h, 2000, "stretch"),
    () => prepareRegion(photo, ...corner, 2000, "binary"),
  ];
  // A sideways photo: the card's bottom edge is on the left or right.
  if (w > h) {
    passes.push(
      () => prepareRegion(photo, w * 0.8, 0, w * 0.2, h, 2000, "stretch", 90),
      () => prepareRegion(photo, 0, 0, w * 0.2, h, 2000, "stretch", -90),
      () => prepareRegion(photo, w * 0.8, 0, w * 0.2, h, 2000, "binary", 90),
      () => prepareRegion(photo, 0, 0, w * 0.2, h, 2000, "binary", -90),
    );
  }
  return passes;
}

async function handleFile(file) {
  if (!file) return;
  currentFile = file;
  showError("");
  $("result").hidden = true;
  $("candidates").hidden = true;
  $("tap-mark").hidden = true;
  $("photo-panel").hidden = false;
  setStatus("Opening the photo…");
  try {
    await loadPhoto(file);
  } catch {
    $("photo-panel").hidden = true;
    showError("Couldn't open that photo. Try taking it again, or choose a JPEG or PNG.");
    return;
  }
  $("photo-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const result = await readCard(photoPasses(), (i, zoom) =>
      setStatus(zoom ? "Zooming in on the number…" : i === 0 ? "Reading the card number…" : `Looking closer (try ${i + 1})…`));
    applyResult(result);
  } catch (err) {
    console.error(err);
    setStatus("Couldn't load the text reader.", false);
    showError("The text reader didn't load. Check your internet connection, or type the code below.");
  }
}

function applyResult(result) {
  if (result && result.choices) {
    const n = result.choices[0].localId;
    $("num-input").value = n;
    $("set-input").value = "";
    setStatus(`Read number ${n}. It's in ${result.choices.length} sets.`, false);
    renderChoices(result.choices);
    return;
  }
  if (result && result.card) {
    const { reading, card } = result;
    $("set-input").value = card.set?.id || reading.setId;
    $("num-input").value = card.localId || reading.number;
    setStatus(`Found ${card.set?.id || reading.setId} ${card.localId || reading.number}.`, false);
    showCard(card);
    return;
  }
  if (result && result.offline) {
    $("set-input").value = result.reading.setId;
    $("num-input").value = result.reading.number;
    setStatus(`Read ${result.reading.setId} ${result.reading.number}.`, false);
    showError("Couldn't reach the card database to check it. Check your connection and tap Look up.");
    return;
  }
  if (result && result.partial) {
    const { setId, number } = result.partial;
    if (setId) $("set-input").value = setId;
    $("num-input").value = number;
    showCandidates(result.candidates);
    setStatus(`Read ${[setId, number].filter(Boolean).join(" ")}, but couldn't match it to a card.`, false);
    showError("Check the code below and fix any wrong letter or digit, or tap the code on the photo to read it again.");
    return;
  }
  setStatus("Couldn't read the card number.", false);
  showError("Tap the set code and number on the photo to zoom in, or type them below.");
}

function renderChoices(cards) {
  const el = $("result");
  el.innerHTML = `
    <p class="eyebrow">Which card is it?</p>
    <p class="muted small" style="margin:0 0 12px">The number fits more than one set. Tap your card.</p>
    <div class="choices">${cards.map((c, i) => `
      <button type="button" class="choice" data-i="${i}">
        ${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'no-img',textContent:'No picture'}))">` : `<span class="no-img">No picture</span>`}
        <span class="choice-name" lang="ja">${esc(c.name)}</span>
        <span class="h-meta">${esc(c.set?.id)} ${esc(c.localId)}</span>
      </button>`).join("")}
    </div>`;
  el.hidden = false;
  el.querySelectorAll(".choice").forEach((b) => b.addEventListener("click", () => {
    const card = cards[Number(b.dataset.i)];
    $("set-input").value = card.set?.id || "";
    showCard(card);
  }));
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showCandidates(ids) {
  const box = $("candidates");
  if (!ids || ids.length < 2) { box.hidden = true; return; }
  box.innerHTML = `<span class="muted small">Which set?</span>` +
    ids.slice(0, 8).map((id) => `<button type="button" data-set="${esc(id)}">${esc(id)}</button>`).join("");
  box.hidden = false;
}

$("candidates").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-set]");
  if (!b) return;
  $("set-input").value = b.dataset.set;
  $("candidates").hidden = true;
  lookup(b.dataset.set, $("num-input").value);
});

// Tap on the photo: zoom into that spot and read it again.
photo.addEventListener("click", async (e) => {
  if (!photo.width) return;
  const rect = photo.getBoundingClientRect();
  // the canvas keeps its aspect ratio inside the box (object-fit: contain)
  const scale = Math.min(rect.width / photo.width, rect.height / photo.height);
  const drawnW = photo.width * scale, drawnH = photo.height * scale;
  const offX = (rect.width - drawnW) / 2, offY = (rect.height - drawnH) / 2;
  const x = (e.clientX - rect.left - offX) / scale;
  const y = (e.clientY - rect.top - offY) / scale;
  if (x < 0 || y < 0 || x > photo.width || y > photo.height) return;

  const sw = photo.width * 0.5, sh = photo.height * 0.08;
  const sx = Math.max(0, Math.min(photo.width - sw, x - sw / 2));
  const sy = Math.max(0, Math.min(photo.height - sh, y - sh / 2));
  const mark = $("tap-mark");
  mark.style.left = `${offX + sx * scale}px`;
  mark.style.top = `${offY + sy * scale}px`;
  mark.style.width = `${sw * scale}px`;
  mark.style.height = `${sh * scale}px`;
  mark.hidden = false;

  showError("");
  setStatus("Reading the area you tapped…");
  try {
    const passes = ["binary", "stretch", "invert"].map((mode) => () => prepareRegion(photo, sx, sy, sw, sh, 2000, mode));
    applyResult(await readCard(passes));
  } catch {
    setStatus("Couldn't load the text reader.", false);
    showError("The text reader didn't load. Check your internet connection, or type the code below.");
  }
});

for (const id of ["camera", "gallery"]) {
  $(id).addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    handleFile(file);
  });
}

// ---------- live camera scanner ----------

const scanner = {
  stream: null,
  running: false,
  busy: false,
  lastKey: null,
  tick: 0,
};
const video = $("video");

async function openScanner() {
  showError("");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    useFileFallback("This browser can't show a live camera here.");
    return;
  }
  $("scanner").hidden = false;
  document.body.classList.add("scanning");
  $("scanner-status").textContent = "Starting the camera…";
  getWorker().catch(() => {}); // start downloading the text reader in parallel
  loadSets();
  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    closeScanner();
    useFileFallback(err && err.name === "NotAllowedError"
      ? "Camera access was blocked. Allow the camera for this site in Chrome's settings, or take a photo instead."
      : "Couldn't start the camera.");
    return;
  }
  video.srcObject = scanner.stream;
  await video.play().catch(() => {});
  const track = scanner.stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
    $("torch").hidden = !caps.torch;
  } catch { $("torch").hidden = true; }
  scanner.running = true;
  scanner.lastKey = null;
  scanner.tick = 0;
  $("scanner-status").textContent = "Line the card up with the frame";
  scanLoop();
}

function closeScanner() {
  scanner.running = false;
  if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
  scanner.stream = null;
  video.srcObject = null;
  $("scanner").hidden = true;
  document.body.classList.remove("scanning");
}

function useFileFallback(message) {
  showError(`${message} Use "Take a photo" below instead.`);
  $("take-photo").hidden = false;
}

// Where the guide frame sits, in video pixels.
function guideRect() {
  const frame = $("guide").getBoundingClientRect();
  const box = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
  const offX = (box.width - vw * scale) / 2, offY = (box.height - vh * scale) / 2;
  const x = (frame.left - box.left - offX) / scale;
  const y = (frame.top - box.top - offY) / scale;
  return { x, y, w: frame.width / scale, h: frame.height / scale };
}

function grabFrame() {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  return c;
}

async function scanLoop() {
  const modes = ["stretch", "binary", "invert"];
  while (scanner.running) {
    if (!video.videoWidth) { await sleep(200); continue; }
    try {
      await getWorker();
    } catch {
      closeScanner();
      showError("The text reader didn't load. Check your internet connection, or type the code below.");
      return;
    }
    const frame = grabFrame();
    const g = guideRect();
    // The code is printed along the bottom edge of the card. Read a generous band
    // around the bottom of the frame, since nobody lines a card up perfectly.
    const sx = Math.max(0, g.x - g.w * 0.08), sy = Math.max(0, g.y + g.h * 0.72);
    const sw = Math.min(frame.width - sx, g.w * 1.16), sh = Math.min(frame.height - sy, g.h * 0.43);
    const mode = modes[scanner.tick++ % modes.length];
    let text = "", words = [], band = null;
    try {
      band = prepareRegion(frame, sx, sy, sw, sh, 1600, mode);
      ({ text, words } = await readText(band));
    } catch { /* keep trying */ }
    if (!scanner.running) return;
    const sets = await loadSets();
    let list = CardReader.readings(text, sets);
    // Number found but not the set code: zoom in on the number and read again.
    if (list.length && !list.some((r) => r.via !== "total") && band) {
      const area = numberArea(words, band, list[0].number);
      if (area) {
        try {
          const code = codePasses(area)[scanner.tick % 2];
          text += " " + (await readText(code(), code.psm)).text;
          const zoom = await readText(zoomPasses(area)[scanner.tick % 3]());
          text += " " + zoom.text;
          const more = CardReader.readings(zoom.text, sets);
          if (more.some((r) => r.via !== "total")) list = more;
        } catch { /* keep trying */ }
      }
    }
    if (list.length) {
      const key = `${list[0].via === "total" ? "?" : list[0].setId} ${list[0].number}`;
      $("scanner-status").textContent = `Reading ${key}…`;
      scanner.sameCount = scanner.lastKey === key ? (scanner.sameCount || 0) + 1 : 0;
      // Only offer a choice of sets after a few tries at reading the set code.
      scanner.texts = (scanner.lastKey === key ? scanner.texts || [] : []).concat(text).slice(-6);
      const hit = await resolveReadings(CardReader.rankByHint(list, scanner.texts), { allowChoices: scanner.sameCount >= 3 });
      if (!scanner.running) return;
      // Accept a reading that matches a real card. Offline, accept the same reading twice in a row.
      if (hit && (hit.card || hit.choices || (hit.offline && scanner.lastKey === key))) {
        if (navigator.vibrate) navigator.vibrate(60);
        const blob = await new Promise((r) => frame.toBlob(r, "image/jpeg", 0.9));
        currentFile = blob ? new File([blob], "card.jpg", { type: "image/jpeg" }) : null;
        closeScanner();
        photo.width = frame.width; photo.height = frame.height;
        photoCtx.drawImage(frame, 0, 0);
        $("photo-panel").hidden = true;
        applyResult(hit);
        return;
      }
      scanner.lastKey = key;
    } else {
      $("scanner-status").textContent = scanner.tick > 6
        ? "Move closer so the code at the bottom fills the box, and avoid glare"
        : "Line the card up with the frame";
    }
    await sleep(150);
  }
}

$("scan-button").addEventListener("click", openScanner);
$("close-scanner").addEventListener("click", closeScanner);
$("torch").addEventListener("click", async () => {
  const track = scanner.stream && scanner.stream.getVideoTracks()[0];
  if (!track) return;
  const on = $("torch").getAttribute("aria-pressed") !== "true";
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    $("torch").setAttribute("aria-pressed", String(on));
  } catch { /* not supported */ }
});
document.addEventListener("visibilitychange", () => { if (document.hidden && scanner.running) closeScanner(); });

// ---------- lookup + result ----------

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const set = $("set-input").value.trim();
  const num = $("num-input").value.trim().split("/")[0];
  if (!set || !num) {
    showError("Enter both the set (like SV2a) and the card number (like 205).");
    return;
  }
  lookup(set, num);
});

async function lookup(setInput, number) {
  showError("");
  $("result").hidden = true;
  let card;
  try {
    card = await fetchCard(setInput, number);
  } catch {
    showError("Couldn't reach the card database. Check your internet connection and try again.");
    return;
  }
  if (!card) {
    const sets = await loadSets();
    const set = sets.find((s) => s.id.toLowerCase() === setInput.toLowerCase());
    renderResult({ notFound: true, setId: set ? set.id : setInput, number, setName: set && set.name });
    return;
  }
  showCard(card);
}

function showCard(card) {
  renderResult(card);
  saveHistory(card);
}

function priceBlocks(card) {
  const blocks = [];
  const pricing = card.pricing || {};
  const cm = pricing.cardmarket;
  if (cm) {
    const holo = !money(cm.trend, "EUR") && money(cm["trend-holo"], "EUR");
    const k = (name) => cm[holo ? `${name}-holo` : name];
    const main = money(k("trend"), "EUR") || money(k("avg"), "EUR");
    if (main) {
      const detail = [
        money(k("avg30"), "EUR") && `30-day average ${money(k("avg30"), "EUR")}`,
        money(k("low"), "EUR") && `lowest listing ${money(k("low"), "EUR")}`,
      ].filter(Boolean).join(" · ");
      blocks.push({ label: "Cardmarket trend price", main, detail, updated: cm.updated });
    }
  }
  const tp = pricing.tcgplayer;
  if (tp) {
    for (const [key, label] of [["normal", ""], ["holofoil", " (holo)"], ["holo", " (holo)"], ["reverse-holofoil", " (reverse holo)"], ["reverse", " (reverse holo)"]]) {
      const v = tp[key];
      if (!v) continue;
      const main = money(v.marketPrice, "USD") || money(v.midPrice, "USD");
      if (!main) continue;
      const lo = money(v.lowPrice, "USD"), hi = money(v.highPrice, "USD");
      blocks.push({ label: `TCGplayer market price${label}`, main, detail: lo && hi ? `listings ${lo} – ${hi}` : "", updated: tp.updated });
      break;
    }
  }
  return blocks;
}

function shopLinks(name, setId, number) {
  const q = encodeURIComponent;
  const ja = [name, number].filter(Boolean).join(" ");
  const en = [setId, number, "japanese pokemon"].filter(Boolean).join(" ");
  return [
    ["Yuyu-tei", "遊々亭", `https://yuyu-tei.jp/sell/poc/s/search?search_word=${q(name || `${setId} ${number}`)}`],
    ["Card Rush", "カードラッシュ", `https://www.cardrush-pokemon.jp/product-list?keyword=${q(ja)}`],
    ["SNKRDUNK", "スニダン", `https://snkrdunk.com/search?keywords=${q(ja)}`],
    ["Mercari", "sold", `https://jp.mercari.com/search?status=sold_out&keyword=${q(ja)}`],
    ["eBay", "sold", `https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=${q(en)}`],
  ];
}

function renderResult(card) {
  const el = $("result");
  const setId = card.notFound ? card.setId : card.set?.id;
  const number = card.notFound ? card.number : card.localId;
  const total = card.set?.cardCount?.official;
  const name = card.notFound ? null : card.name;
  const setName = card.notFound ? card.setName : card.set?.name;

  const head = card.notFound
    ? `<h2>${esc(setId)} ${esc(number)}</h2>
       <p class="sub-name">This card isn't in the free database. Check the code is right, or check prices below.</p>`
    : `<h2 lang="ja">${esc(name)}</h2>
       <div class="strip">
         <span>${esc(setId)}</span><span>${esc(number)}${total ? "/" + esc(total) : ""}</span>
         ${card.rarity ? `<span class="rarity">${esc(card.rarity)}</span>` : ""}
       </div>
       ${setName ? `<p class="set-name" lang="ja">${esc(setName)}</p>` : ""}`;

  const img = card.image ? `<img src="${esc(card.image)}/high.webp" alt="" loading="lazy" onerror="this.remove()">` : "";

  const prices = card.notFound ? [] : priceBlocks(card);
  const priceHtml = prices.length
    ? prices.map((p) => `<div class="price">
        <span class="label">${esc(p.label)}</span>
        <span class="big">${esc(p.main)}</span>
        ${p.detail ? `<span class="detail">${esc(p.detail)}</span>` : ""}
        ${p.updated ? `<span class="detail">Updated ${esc(new Date(p.updated).toLocaleDateString())}</span>` : ""}
      </div>`).join("")
    : card.notFound ? "" : `<div class="no-price">No market price listed for this card. Check the Japanese shops below.</div>`;

  const links = shopLinks(name, setId, number).map(([n, sub, url]) =>
    `<a class="chip-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(n)}${sub ? ` <small>${esc(sub)}</small>` : ""} ↗</a>`).join("");

  el.innerHTML = `
    <div class="card-head">${img}<div>${head}</div></div>
    ${priceHtml ? `<div class="prices">${priceHtml}</div>` : ""}
    <p class="links-head">Japanese shop prices</p>
    <div class="links">${links}</div>
    <div class="ask">
      <button type="button" class="ask-button" id="ask-claude">Ask Claude about this card</button>
      <span class="muted small">Opens your Claude app with ${currentFile ? "the photo and " : ""}a question ready to send.</span>
    </div>`;
  el.hidden = false;
  $("ask-claude").addEventListener("click", () => askClaude({ setId, number, name }));
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Ask Claude (uses the Claude app, no API key) ----------

function claudePrompt(info) {
  const code = info && info.setId ? ` I think it's ${info.setId} ${info.number}${info.name ? ` (${info.name})` : ""}.` : "";
  return `This is a Japanese Pokémon card.${code} Please confirm the exact card: name in Japanese and English, set, number, rarity, and anything that changes its value (promo stamp, reverse holo pattern, grading). Then give me a rough current market value in yen and US dollars for a raw near-mint copy.`;
}

async function askClaude(info) {
  const text = claudePrompt(info);
  // Copy first, in case the app drops the shared text.
  try { navigator.clipboard?.writeText(text).catch(() => {}); } catch {}
  const files = currentFile ? [new File([currentFile], currentFile.name || "card.jpg", { type: currentFile.type || "image/jpeg" })] : [];
  try {
    if (files.length && navigator.canShare && navigator.canShare({ files })) {
      await navigator.share({ files, text, title: "Pokémon card" });
      return;
    }
    if (navigator.share) {
      await navigator.share({ text, title: "Pokémon card" });
      return;
    }
  } catch (err) {
    if (err && err.name === "AbortError") return; // closed the share menu
  }
  window.open(`https://claude.ai/new?q=${encodeURIComponent(text)}`, "_blank", "noopener");
}

// ---------- history ----------

function saveHistory(card) {
  const prices = priceBlocks(card);
  const entry = {
    at: Date.now(),
    setId: card.set?.id,
    number: card.localId,
    name: card.name,
    rarity: card.rarity,
    price: prices[0]?.main || null,
  };
  const items = readStore(HISTORY_KEY, []).filter((i) => !(i.setId === entry.setId && i.number === entry.number));
  writeStore(HISTORY_KEY, [entry, ...items].slice(0, HISTORY_LIMIT));
  renderHistory();
}

function renderHistory() {
  const items = readStore(HISTORY_KEY, []);
  $("history-empty").hidden = items.length > 0;
  $("clear-history").hidden = items.length === 0;
  $("history-list").innerHTML = items.map((i, n) => `<li><button type="button" data-index="${n}">
      <span><span lang="ja">${esc(i.name || "Unknown")}</span><br><span class="h-meta">${esc([i.setId, i.number, i.rarity].filter(Boolean).join(" · "))}</span></span>
      <span class="h-price">${esc(i.price || "—")}</span>
    </button></li>`).join("");
}

$("history-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-index]");
  if (!b) return;
  const item = readStore(HISTORY_KEY, [])[Number(b.dataset.index)];
  if (!item) return;
  currentFile = null;
  $("photo-panel").hidden = true;
  $("set-input").value = item.setId;
  $("num-input").value = item.number;
  cardCache.delete(`${item.setId}-${String(item.number).replace(/^0+(?=\d)/, "")}`.toLowerCase());
  lookup(item.setId, item.number); // fetch fresh prices
});

$("clear-history").addEventListener("click", () => { writeStore(HISTORY_KEY, []); renderHistory(); });

renderHistory();
loadSets();

// Offline support: cache the app, the text reader and card data.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
