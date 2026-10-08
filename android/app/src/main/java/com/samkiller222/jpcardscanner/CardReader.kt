package com.samkiller222.jpcardscanner

/**
 * Turns text read from a Japanese card into likely set code + collector number
 * readings. Plain Kotlin with no Android dependencies, so it can be unit tested.
 * Kept in step with docs/reader.js in the web app.
 */
object CardReader {

    data class SetInfo(val id: String, val name: String?, val official: Int?)

    /** via = "code" when the set code was read, "total" when only the printed card count matched. */
    data class Reading(val setId: String, val number: String, val via: String)

    data class Number(val number: String, val total: String?, val promoSet: String? = null)

    // OCR mix-ups between letters and digits, in both directions.
    private val toDigit = mapOf(
        'O' to '0', 'o' to '0', 'D' to '0', 'Q' to '0', 'I' to '1', 'l' to '1', 'i' to '1', '|' to '1',
        'Z' to '2', 'z' to '2', 'S' to '5', 's' to '5', 'B' to '8', 'G' to '6', 'g' to '9', 'A' to '4', 'T' to '7',
    )
    private val toLetter = mapOf('0' to 'O', '1' to 'I', '2' to 'Z', '5' to 'S', '8' to 'B', '6' to 'G', '4' to 'A')

    private fun digits(s: String) = s.map { if (it.isDigit()) it else toDigit[it] ?: it }.joinToString("")

    private val numberRe = Regex("""([0-9OoDQIl|iZzSsBG]{1,3})\s*[/⁄∕|]\s*([0-9OoDQIl|iZzSsBG]{2,3})(?![0-9])""")
    private val fusedRe = Regex("""(?:^|[^0-9])(\d{3})[71](\d{3})(?![0-9])""")
    private val promoRe = Regex("""(\d{3})\s*/\s*(S[VM]?-P)""", RegexOption.IGNORE_CASE)

    /** "205/165", "2O5 / 165", "OO1/O78" -> numbers; "0707066" (slash read as 7) -> 070/066. */
    fun findNumbers(text: String): List<Number> {
        val out = mutableListOf<Number>()
        for (m in numberRe.findAll(text)) {
            val n = digits(m.groupValues[1])
            val t = digits(m.groupValues[2])
            if (n.all { it.isDigit() } && t.all { it.isDigit() } && n.toInt() > 0 && t.toInt() > 0) {
                out += Number(n, t)
            }
        }
        for (m in fusedRe.findAll(text)) {
            val n = m.groupValues[1]
            val t = m.groupValues[2]
            if (out.none { it.number == n && it.total == t } && n.toInt() > 0 && t.toInt() > 0) out += Number(n, t)
        }
        for (m in promoRe.findAll(text)) out += Number(m.groupValues[1], null, m.groupValues[2].uppercase())
        return out
    }

    private fun setKey(token: String) = token.uppercase().replace(Regex("[^A-Z0-9.\\-]"), "")

    /** Likely corrections of an OCR'd set code token, e.g. "5V2a", "SVZa" -> "SV2A". */
    fun variants(token: String): List<String> {
        val out = linkedSetOf(setKey(token))
        for (v in out.toList()) out += v.replace(Regex("^[5$]"), "S").replace(Regex("^SU"), "SV")
        for (v in out.toList()) {
            Regex("^([A-Z]{1,2})(.+?)([A-Z]{0,2})$").matchEntire(v)?.let {
                out += it.groupValues[1] + digits(it.groupValues[2]) + it.groupValues[3]
            }
            Regex("^([A-Z]{1,2})(\\d+)(.*)$").matchEntire(v)?.let {
                out += it.groupValues[1] + it.groupValues[2] + it.groupValues[3].map { c -> toLetter[c] ?: c }.joinToString("")
            }
        }
        return out.toList()
    }

    /** Every plausible reading of the text, most likely first. The caller checks each against the database. */
    fun readings(text: String, sets: List<SetInfo>): List<Reading> {
        val byKey = sets.associateBy { setKey(it.id) }
        val found = mutableListOf<SetInfo>()
        for (token in text.split(Regex("[^A-Za-z0-9.\\-$|]+"))) {
            if (token.length < 2 || token.length > 8) continue
            for (v in variants(token)) {
                val set = byKey[v]
                if (set != null && set.id.any { it.isDigit() }) {
                    if (set !in found) found += set
                    break
                }
            }
        }
        val out = mutableListOf<Reading>()
        fun add(setId: String, number: String, via: String) {
            if (out.none { it.setId == setId && it.number == number }) out += Reading(setId, number, via)
        }
        for (n in findNumbers(text)) {
            if (n.promoSet != null) {
                add(byKey[setKey(n.promoSet)]?.id ?: n.promoSet, n.number, "code")
                continue
            }
            val total = n.total?.toIntOrNull()
            // a set code that agrees with the printed total is the strongest reading
            for (s in found) if (s.official == total) add(s.id, n.number, "code")
            for (s in found) add(s.id, n.number, "code")
            for (s in sets) if (s.official == total) add(s.id, n.number, "total")
        }
        return out
    }

    /**
     * Put readings whose set id shares the most letters with text the reader saw first
     * (a partly read "sv" favours SV4M and SV4K over BW2), and drop the ones with nothing
     * in common when some do match.
     */
    fun rankByHint(list: List<Reading>, texts: List<String>): List<Reading> {
        val tokens = texts.joinToString(" ").lowercase().split(Regex("[^a-z0-9.\\-]+")).filter { it.length >= 2 }
        fun score(id: String): Int {
            val key = id.lowercase()
            if (tokens.none { it.contains(key.take(2)) }) return 0
            var best = 0
            for (t in tokens) {
                for (len in minOf(key.length, t.length) downTo best + 1) {
                    if ((0..key.length - len).any { t.contains(key.substring(it, it + len)) }) {
                        best = len
                        break
                    }
                }
            }
            return if (best >= 2) best else 0
        }
        val scored = list.map { it to if (it.via == "total") score(it.setId) else 99 }
        val anyHit = scored.any { it.first.via == "total" && it.second > 0 }
        return scored
            .filter { !anyHit || it.first.via != "total" || it.second > 0 }
            .sortedByDescending { it.second }
            .map { it.first }
    }

    /** TCGdex stores collector numbers zero-padded to 3 digits ("001"). */
    fun localIds(number: String): List<String> {
        val n = number.trim().replace(Regex("^0+(?=\\d)"), "")
        return listOf(n.padStart(3, '0'), n).distinct()
    }

    /** Japanese text with spaces removed, for matching a card name printed on the card. */
    fun squash(s: String) = s.replace(Regex("\\s+"), "")
}
