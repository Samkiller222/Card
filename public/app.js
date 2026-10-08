const MAX_SIDE = 1568; // larger images don't help Claude read the card and just slow the upload
const HISTORY_KEY = "jp-card-scanner-history";
const HISTORY_LIMIT = 30;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const errorEl = $("error");
const resultEl = $("result");

const STATUS_MESSAGES = [
  "Reading the card…",
  "Checking the set code and number…",
  "Searching Japanese shops…",
  "Checking sold listings…",
  "Putting the prices together…",
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function formatMoney(amount, currency) {
  if (typeof amount !== "number" || !isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatRange(low, high, currency) {
  if (low === high) return formatMoney(low, currency);
  return `${formatMoney(low, currency)} – ${formatMoney(high, currency)}`;
}

// Downscale the photo in the browser and return base64 JPEG.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
  const thumb = document.createElement("canvas");
  const tScale = 160 / Math.max(canvas.width, canvas.height);
  thumb.width = Math.round(canvas.width * tScale);
  thumb.height = Math.round(canvas.height * tScale);
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return {
    base64: dataUrl.split(",")[1],
    previewUrl: dataUrl,
    thumbUrl: thumb.toDataURL("image/jpeg", 0.7),
  };
}

function searchLinks(card) {
  const ja = [card.name_ja, card.number].filter(Boolean).join(" ");
  const en = [card.name_en, card.set_code, card.number, "japanese"].filter(Boolean).join(" ");
  const q = encodeURIComponent;
  return [
    ["Yuyu-tei", `https://yuyu-tei.jp/sell/poc/s/search?search_word=${q(card.name_ja || "")}`],
    ["Card Rush", `https://www.cardrush-pokemon.jp/product-list?keyword=${q(ja)}`],
    ["SNKRDUNK", `https://snkrdunk.com/search?keywords=${q(ja)}`],
    ["PriceCharting", `https://www.pricecharting.com/search-products?type=prices&q=${q(en)}`],
    ["eBay sold", `https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=${q(en)}`],
  ];
}

function renderResult(result, previewUrl) {
  const card = result.card || {};
  const prices = Array.isArray(result.prices) ? result.prices : [];
  const est = result.estimate;
  const confidence = ["high", "medium", "low"].includes(card.confidence) ? card.confidence : "low";

  const tags = [card.set_code, card.set_name, card.number, card.rarity, card.variant]
    .filter(Boolean)
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");

  const estimateHtml = est
    ? `<div class="estimate">
         <div class="label">Estimated value (raw, near mint)</div>
         <div class="big">${escapeHtml(formatRange(est.low_jpy, est.high_jpy, "JPY"))}</div>
         <div>≈ ${escapeHtml(formatRange(est.low_usd, est.high_usd, "USD"))}</div>
       </div>`
    : `<div class="estimate"><div class="label">No reliable prices found — try the links below.</div></div>`;

  const rows = prices
    .map((p) => {
      const url = safeUrl(p.url);
      const source = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(p.source)}</a>`
        : escapeHtml(p.source);
      const meta = [p.kind, p.date].filter(Boolean).map(escapeHtml).join(" · ");
      return `<tr>
        <td>${source}<br><small>${meta}</small></td>
        <td>${escapeHtml(p.condition)}</td>
        <td class="num">${escapeHtml(formatMoney(p.price, p.currency || "JPY"))}</td>
      </tr>`;
    })
    .join("");

  const links = searchLinks(card)
    .map(([name, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)} ↗</a>`)
    .join("");

  resultEl.innerHTML = `
    <div class="card-head">
      ${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="">` : ""}
      <div>
        <h2>${escapeHtml(card.name_en || "Unknown card")}</h2>
        <p class="name-ja">${escapeHtml(card.name_ja)}</p>
        <div class="tags">${tags}<span class="tag conf-${confidence}">${confidence} confidence</span></div>
      </div>
    </div>
    ${estimateHtml}
    ${rows ? `<table><thead><tr><th>Source</th><th>Condition</th><th class="num">Price</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    ${result.notes ? `<p class="notes">${escapeHtml(result.notes)}</p>` : ""}
    <div class="check-links">${links}</div>
  `;
  resultEl.hidden = false;
}

// ---- history (kept on this device only) ----

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(items) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
  } catch {
    // storage full or blocked: history is a convenience, so ignore
  }
}

function renderHistory() {
  const items = loadHistory();
  $("history-empty").hidden = items.length > 0;
  $("history-list").innerHTML = items
    .map((item, i) => {
      const card = item.result.card || {};
      const est = item.result.estimate;
      const price = est ? formatRange(est.low_jpy, est.high_jpy, "JPY") : "—";
      const when = new Date(item.at).toLocaleDateString();
      return `<li data-index="${i}">
        <span>${escapeHtml(card.name_en || card.name_ja || "Unknown")}<br>
          <small>${escapeHtml([card.set_code, card.number].filter(Boolean).join(" "))} · ${escapeHtml(when)}</small></span>
        <span class="h-price">${escapeHtml(price)}</span>
      </li>`;
    })
    .join("");
}

$("history-list").addEventListener("click", (event) => {
  const li = event.target.closest("li[data-index]");
  if (!li) return;
  const item = loadHistory()[Number(li.dataset.index)];
  if (!item) return;
  errorEl.hidden = true;
  renderResult(item.result, item.thumb);
  resultEl.scrollIntoView({ behavior: "smooth" });
});

$("clear-history").addEventListener("click", () => {
  saveHistory([]);
  renderHistory();
});

// ---- scanning ----

async function handleFile(file) {
  if (!file) return;
  errorEl.hidden = true;
  resultEl.hidden = true;

  let image;
  try {
    image = await prepareImage(file);
  } catch {
    errorEl.textContent = "Couldn't open that photo. Try a JPEG or PNG.";
    errorEl.hidden = false;
    return;
  }

  $("preview").src = image.thumbUrl;
  statusEl.hidden = false;
  let step = 0;
  $("status-text").textContent = STATUS_MESSAGES[0];
  const ticker = setInterval(() => {
    step = Math.min(step + 1, STATUS_MESSAGES.length - 1);
    $("status-text").textContent = STATUS_MESSAGES[step];
  }, 7000);

  try {
    const response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: image.base64, mediaType: "image/jpeg" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Scan failed (${response.status})`);

    renderResult(body, image.previewUrl);
    saveHistory([{ at: Date.now(), result: body, thumb: image.thumbUrl }, ...loadHistory()]);
    renderHistory();
    resultEl.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    errorEl.textContent = err.message || "Something went wrong. Try again.";
    errorEl.hidden = false;
  } finally {
    clearInterval(ticker);
    statusEl.hidden = true;
  }
}

for (const id of ["camera", "gallery"]) {
  $(id).addEventListener("change", (event) => {
    handleFile(event.target.files[0]);
    event.target.value = "";
  });
}

renderHistory();
