// Pure parsing helpers: turn OCR text from the bottom of a Japanese card into
// a set code + collector number. Kept free of DOM code so it can be tested.
(function (root) {
  // OCR mix-ups between letters and digits, in both directions.
  const TO_DIGIT = { O: "0", o: "0", D: "0", Q: "0", I: "1", l: "1", i: "1", "|": "1", Z: "2", z: "2", S: "5", s: "5", B: "8", G: "6", g: "9", A: "4", T: "7" };
  const TO_LETTER = { 0: "O", 1: "I", 2: "Z", 5: "S", 8: "B", 6: "G", 4: "A" };

  function digits(str) {
    return str.split("").map((c) => (/\d/.test(c) ? c : TO_DIGIT[c] || c)).join("");
  }

  // "205/165", "2O5 / 165", "OO1/O78" -> { number: "205", total: "165" }
  function findNumbers(text) {
    const out = [];
    const re = /([0-9OoDQIl|iZzSsBG]{1,3})\s*[\/⁄∕|]\s*([0-9OoDQIl|iZzSsBG]{2,3})(?![0-9])/g;
    let m;
    while ((m = re.exec(text))) {
      const number = digits(m[1]);
      const total = digits(m[2]);
      if (/^\d+$/.test(number) && /^\d+$/.test(total) && Number(number) > 0 && Number(total) > 0) {
        out.push({ number, total });
      }
    }
    // Promo cards print like "001/SV-P" or "123/S-P".
    const promo = /(\d{3})\s*\/\s*(S[VM]?-P)/gi;
    while ((m = promo.exec(text))) out.push({ number: m[1], total: null, promoSet: m[2].toUpperCase() });
    return out;
  }

  // Normalise a token for comparing with real set ids: uppercase, and map
  // letters that look like digits after the series prefix, and vice versa.
  function setKey(token) {
    return token.toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  }

  // Generate likely corrections of an OCR'd token (e.g. "SV2A", "5V2a", "SVZa").
  function variants(token) {
    const base = setKey(token);
    const out = new Set([base]);
    // Fix the series prefix: first 1-2 chars should be letters.
    for (const v of [...out]) {
      out.add(v.replace(/^[5$]/, "S").replace(/^S[U]/, "SV"));
    }
    // Middle part should be digits.
    for (const v of [...out]) {
      const m = v.match(/^([A-Z]{1,2})(.+?)([A-Z]{0,2})$/);
      if (m) out.add(m[1] + digits(m[2]) + m[3]);
      const m2 = v.match(/^([A-Z]{1,2})(\d+)(.*)$/);
      if (m2) out.add(m2[1] + m2[2] + m2[3].split("").map((c) => TO_LETTER[c] || c).join(""));
    }
    return [...out];
  }

  // sets: [{ id, cardCount: { official, total } }] from TCGdex.
  // Returns { setId, number, total, candidates } or null.
  function parseCardText(text, sets) {
    const byKey = new Map(sets.map((s) => [setKey(s.id), s]));
    const numbers = findNumbers(text);

    // Set codes seen in the text, matched against real set ids.
    const found = [];
    for (const token of text.split(/[^A-Za-z0-9.\-$|]+/)) {
      if (token.length < 2 || token.length > 8) continue;
      for (const v of variants(token)) {
        const set = byKey.get(v);
        if (set && /\d/.test(set.id)) {
          found.push(set);
          break;
        }
      }
    }

    const num = numbers.find((n) => !n.promoSet) || numbers[0] || null;
    if (num && num.promoSet) {
      const set = byKey.get(setKey(num.promoSet));
      return { setId: set ? set.id : num.promoSet, number: num.number, total: null, candidates: [] };
    }

    // Prefer a set code whose card count matches the printed total.
    let setId = null;
    if (num && num.total) {
      const match = found.find((s) => String(s.cardCount && s.cardCount.official) === String(Number(num.total)));
      if (match) setId = match.id;
    }
    if (!setId && found.length) setId = found[0].id;

    // No readable set code: list sets with the same printed total.
    let candidates = [];
    if (num && num.total) {
      candidates = sets.filter((s) => String(s.cardCount && s.cardCount.official) === String(Number(num.total))).map((s) => s.id);
      if (!setId && candidates.length === 1) setId = candidates[0];
    }

    if (!setId && !num) return null;
    return { setId, number: num ? num.number : null, total: num ? num.total : null, candidates };
  }

  // TCGdex stores collector numbers zero-padded to 3 digits ("001").
  function localIds(number) {
    const n = String(number).trim().replace(/^0+(?=\d)/, "");
    const ids = [n.padStart(3, "0"), n];
    return [...new Set(ids)];
  }

  const api = { findNumbers, parseCardText, localIds, variants };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CardReader = api;
})(typeof window !== "undefined" ? window : globalThis);
