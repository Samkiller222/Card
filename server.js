import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TURNS = 6;

const client = new Anthropic();

const SYSTEM_PROMPT = `You identify Japanese Pokémon TCG cards from photos and report what they currently sell for.

Step 1 - identify the card from the photo. Read the Japanese text carefully:
- The card name (top of the card), and its English name.
- The set code (small code at the bottom-left, e.g. "SV2a", "SV8a", "S12a", "SM12a") and the collector number (e.g. "165/165", "201/165", "SAR 330/190").
- The rarity mark (C, U, R, RR, RRR, AR, SR, SAR, UR, HR, CHR, CSR, S, SSR, ACE, PROMO, etc.).
- Anything that changes value: first edition mark, master ball / poke ball reverse holo pattern, promo stamps, grading slab (PSA/BGS/CGC grade).
If the photo is not a Pokémon card, or it is too blurry to read the number, say so in the notes and lower the confidence.

Step 2 - look up current prices with web search. Search in Japanese and English using the name, set code and number. Good sources:
- Japanese shops: Yuyu-tei (遊々亭), Card Rush (カードラッシュ), SNKRDUNK (スニダン), Hareruya2 (晴れる屋2), Torecolo, Mercari sold listings.
- International: PriceCharting (Japanese sets), eBay sold listings, TCGplayer/Cardmarket if they list the Japanese print.
Prefer actual sale/sold prices and current shop sell prices over asking prices. Note whether a price is for raw (ungraded) or a specific grade. Use only prices you actually found; never invent a number.

Finish your reply with exactly one JSON object inside a \`\`\`json fenced block, and nothing after it, in this shape:
{
  "card": {
    "name_ja": string,           // Japanese name as printed
    "name_en": string,           // English name
    "set_code": string | null,   // e.g. "SV2a"
    "set_name": string | null,   // e.g. "Pokémon Card 151"
    "number": string | null,     // e.g. "201/165"
    "rarity": string | null,     // e.g. "SAR"
    "variant": string | null,    // e.g. "Master Ball Reverse Holo", "PSA 10", or null
    "confidence": "high" | "medium" | "low"
  },
  "prices": [                    // one entry per price you found
    {
      "source": string,          // e.g. "Yuyu-tei"
      "condition": string,       // e.g. "Raw (near mint)", "PSA 10"
      "kind": "shop sell price" | "sold listing" | "market average" | "buylist",
      "price": number,
      "currency": "JPY" | "USD" | "EUR" | string,
      "url": string | null,
      "date": string | null      // when the price was observed, if shown
    }
  ],
  "estimate": {                  // your best single estimate for a raw near-mint copy, or null if no prices were found
    "low_jpy": number, "high_jpy": number,
    "low_usd": number, "high_usd": number
  } | null,
  "notes": string                // short caveats: things that could change the value, uncertainty, etc.
}`;

function extractJson(text) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = fenced.length
    ? fenced[fenced.length - 1][1]
    : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function scanCard(imageBase64, mediaType) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: "Identify this Japanese Pokémon card and find its current market price." },
      ],
    },
  ];

  let response;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 8 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 },
      ],
      messages,
    });
    response = await stream.finalMessage();

    // A long server-tool turn can pause; resend the partial turn to let it continue.
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to process this image.");
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const result = extractJson(text);
  if (!result) {
    throw new Error("Could not read a result from the model's reply. Try another photo.");
  }
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Image too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/scan") {
    try {
      const { image, mediaType } = JSON.parse(await readBody(req));
      if (typeof image !== "string" || !ALLOWED_TYPES.has(mediaType)) {
        sendJson(res, 400, { error: "Send a JPEG, PNG, WebP or GIF image." });
        return;
      }
      const started = Date.now();
      const result = await scanCard(image, mediaType);
      console.log(`Scanned "${result.card?.name_en}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      sendJson(res, 200, result);
    } catch (error) {
      console.error(error);
      if (error instanceof Anthropic.AuthenticationError) {
        sendJson(res, 500, { error: "Server is missing a valid ANTHROPIC_API_KEY." });
      } else if (error instanceof Anthropic.RateLimitError) {
        sendJson(res, 429, { error: "Rate limited - wait a moment and try again." });
      } else if (error instanceof Anthropic.APIError) {
        sendJson(res, 502, { error: `Claude API error (${error.status}). Try again.` });
      } else {
        sendJson(res, error.status || 500, { error: error.message });
      }
    }
    return;
  }
  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405).end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Card scanner running on http://localhost:${PORT}`);
  console.log("On your phone (same Wi-Fi), open http://<this computer's IP>:" + PORT);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set - scans will fail until you set it.");
  }
});
