# JP Card Scanner

Take a photo of a Japanese Pokémon card on your phone and get its current price.

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
