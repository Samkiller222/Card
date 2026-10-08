# JP Card Scanner

Take a photo of a Japanese Pokémon card on your phone and get its current price.

There are two versions:

- **Free web app (`docs/`)**: runs entirely in your phone's browser and is hosted free on GitHub Pages. It needs no API key and no server.
- **Server version (`server.js`)**: uses the Claude API to read the card and search the web for live prices. It needs a computer and an API key, and costs money per scan.

## Free web app (GitHub Pages)

1. Tap **Scan a card** and take a photo. [Tesseract.js](https://tesseract.projectnaptha.com) reads the set code and number from the bottom corner of the card (e.g. `SV2a 205/165`). This runs on your phone.
2. The app checks the code against the list of Japanese sets in [TCGdex](https://tcgdex.dev). That also corrects common misreads, like `O` for `0` or `5` for `S`.
3. It shows the card's picture, name and rarity, plus its **Cardmarket** (€) and **TCGplayer** ($) market prices when those sites list it.
4. Buttons open Yuyu-tei, Card Rush, SNKRDUNK, Mercari (sold) and eBay (sold), already searched for that card.
5. **Ask Claude about this card** shares the photo to your Claude app with a question ready to send. It uses your normal Claude account, so you don't need an API key.

If the number is misread, tap the code on the photo to zoom in and read it again, or type it in.

### Turn on GitHub Pages

1. The repository must be **public**, because GitHub Pages is free only for public repositories.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*.
4. Pick the branch that contains `docs/`, choose the **/docs** folder, then tap **Save**.
5. After a minute or two, the site is live at `https://<your-username>.github.io/<repo>/`. In Chrome on Android, open it, then tap ⋮ → **Add to Home screen**.

## Server version

1. Your phone sends the photo to a small Node server.
2. The server asks Claude to read the card: the Japanese name, set code (e.g. `SV2a`), number (e.g. `201/165`), rarity, and anything else that affects value, like a stamp or a grading slab.
3. Claude searches the web for current prices. It checks Japanese shops (Yuyu-tei, Card Rush, SNKRDUNK, Hareruya2, Mercari) and international sources (PriceCharting, eBay sold listings).
4. The page shows the card, an estimated value range in ¥ and $, each price it found with a link to the source, and quick links so you can check the price yourself.

Your recent scans are saved on your phone.

## Setup

You need Node 18+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Open `http://localhost:3000` on the computer. To use your phone, connect it to the same Wi-Fi and open `http://<your computer's IP>:3000`. Tap **Scan a card** to open the camera.

Optional environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for reading cards and searching prices |

## Tips for good scans

- Lay the card flat in even light, without glare from sleeves or toploaders.
- Make sure the set code and number at the bottom left are sharp. That's how the exact print is identified.
- A scan takes about 20–60 seconds, because prices are looked up live.

## Notes

- Each scan is one Claude API call with web search, so it costs a few cents.
- The price range is an estimate for a raw, near-mint copy, built from the listings found. Graded copies and condition can change the value a lot, so check the source links before you buy or sell.
