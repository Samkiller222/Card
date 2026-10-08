const API = "https://api.tcgdex.net/v2/ja";
const SETS_KEY = "jp-card-scanner-sets";
const SETS_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
const HISTORY_KEY = "jp-card-scanner-history";
const HISTORY_LIMIT = 40;
const PHOTO_MAX_SIDE = 1600;

const $ = (id) => document.getElementById(id);
const photo = $("photo");
const photoCtx = photo.getContext("2d", { willReadFrequently: true });

let currentFile = null; // the photo, kept for "Ask Claude"
let setsPromise = null;
let workerPromise = null;

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

// ---------- TCGdex data ----------

function loadSets() {
  if (setsPromise) return setsPromise;
  const cached = readStore(SETS_KEY, null);
  if (cached && Date.now() - cached.at < SETS_MAX_AGE && Array.isArray(cached.sets)) {
    setsPromise = Promise.resolve(cached.sets);
    return setsPromise;
  }
  setsPromise = fetch(`${API}/sets`)
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

async function fetchCard(setId, number) {
  for (const localId of CardReader.localIds(number)) {
    const res = await fetch(`${API}/cards/${encodeURIComponent(`${setId}-${localId}`)}`);
    if (res.ok) return res.json();
    if (res.status !== 404) throw new Error(`TCGdex error ${res.status}`);
  }
  return null;
}

// ---------- text reading (OCR) ----------

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // A failed download is reported through errorHandler, not by rejecting createWorker.
      const worker = await new Promise((resolve, reject) => {
        Tesseract.createWorker("eng", 1, {
          logger: (m) => {
            if (m.status && m.status.startsWith("loading") && typeof m.progress === "number") {
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

// Copy a region of the photo, scaled up, in high-contrast greyscale.
function prepareRegion(sx, sy, sw, sh, targetWidth) {
  const scale = Math.max(1, Math.min(4, targetWidth / sw));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let min = 255, max = 0;
  const grey = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    grey[j] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = ((grey[j] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function readRegion(region) {
  const worker = await getWorker();
  const { data } = await worker.recognize(region);
  return data.text || "";
}

// Try the whole photo, then the bottom strip zoomed in.
async function readCardCode() {
  const sets = await loadSets();
  const w = photo.width, h = photo.height;
  const passes = [
    () => prepareRegion(0, 0, w, h, 1800),
    () => prepareRegion(0, h * 0.8, w, h * 0.2, 2000),
    () => prepareRegion(0, h * 0.86, w * 0.6, h * 0.14, 2000),
  ];
  let best = null;
  for (let i = 0; i < passes.length; i++) {
    setStatus(i === 0 ? "Reading the card number…" : "Looking closer at the bottom of the card…");
    const text = await readRegion(passes[i]());
    const parsed = CardReader.parseCardText(text, sets);
    if (parsed && parsed.setId && parsed.number) return parsed;
    if (parsed && !best) best = parsed;
  }
  return best;
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

function thumbnail() {
  const c = document.createElement("canvas");
  const s = 120 / Math.max(photo.width, photo.height);
  c.width = Math.round(photo.width * s);
  c.height = Math.round(photo.height * s);
  c.getContext("2d").drawImage(photo, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
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
    const parsed = await readCardCode();
    applyParsed(parsed);
  } catch (err) {
    console.error(err);
    setStatus("Couldn't load the text reader.", false);
    showError("The text reader didn't load. Check your internet connection, or type the code below.");
  }
}

function applyParsed(parsed) {
  if (parsed && parsed.setId && parsed.number) {
    $("set-input").value = parsed.setId;
    $("num-input").value = parsed.number;
    setStatus(`Read ${parsed.setId} ${parsed.number}${parsed.total ? "/" + parsed.total : ""}.`, false);
    lookup(parsed.setId, parsed.number);
    return;
  }
  if (parsed && parsed.number) {
    $("num-input").value = parsed.number;
    showCandidates(parsed.candidates);
    setStatus(`Read number ${parsed.number}${parsed.total ? "/" + parsed.total : ""}, but not the set.`, false);
    $("set-input").focus();
    return;
  }
  setStatus("Couldn't read the card number.", false);
  showError("Tap the set code and number on the photo to zoom in, or type them below.");
}

function showCandidates(ids) {
  const box = $("candidates");
  if (!ids || !ids.length) { box.hidden = true; return; }
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
    const sets = await loadSets();
    const text = await readRegion(prepareRegion(sx, sy, sw, sh, 2000));
    const parsed = CardReader.parseCardText(text, sets);
    if (parsed) applyParsed(parsed);
    else {
      setStatus("Nothing readable there.", false);
      showError("Couldn't read a code there. Tap right on the small code, or type it below.");
    }
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
  const sets = await loadSets();
  // Match the set id case-insensitively against TCGdex's list.
  const set = sets.find((s) => s.id.toLowerCase() === setInput.toLowerCase());
  const setId = set ? set.id : setInput;
  let card;
  try {
    card = await fetchCard(setId, number);
  } catch {
    showError("Couldn't reach the card database. Check your internet connection and try again.");
    return;
  }
  if (!card) {
    renderResult({ notFound: true, setId, number, setName: set && set.name });
    return;
  }
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
      blocks.push({ label: "Cardmarket trend price", main, detail, updated: cm.updated, url: card.variants?.cardmarket });
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
       <p class="sub-name">This card isn't in the free database yet. You can still check prices below.</p>`
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
  lookup(item.setId, item.number); // fetch fresh prices
});

$("clear-history").addEventListener("click", () => { writeStore(HISTORY_KEY, []); renderHistory(); });

renderHistory();
loadSets();
