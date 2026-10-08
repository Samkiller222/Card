package com.samkiller222.jpcardscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

data class PriceBlock(val label: String, val main: String, val detail: String, val updated: String?)

data class Card(
    val id: String,
    val localId: String,
    val name: String,
    val rarity: String?,
    val image: String?,
    val setId: String,
    val setName: String?,
    val official: Int?,
    val prices: List<PriceBlock>,
)

sealed class Match {
    data class Found(val card: Card) : Match()
    data class Choices(val cards: List<Card>) : Match()
    data class Offline(val reading: CardReader.Reading) : Match()
    data object None : Match()
}

/** Card data and prices from the free TCGdex API (Japanese cards). */
class Tcgdex(context: Context) {
    private val api = "https://api.tcgdex.net/v2/ja"
    private val prefs = context.getSharedPreferences("tcgdex", Context.MODE_PRIVATE)
    private val cards = ConcurrentHashMap<String, Card>()
    private val missing = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var sets: List<CardReader.SetInfo>? = null

    private class NotFound : Exception()

    /** GET with a timeout and two retries, so a patchy connection doesn't fail a scan. */
    private suspend fun get(url: String): String = withContext(Dispatchers.IO) {
        var last: Exception = IOException("No response")
        repeat(3) { attempt ->
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 10_000
                conn.readTimeout = 15_000
                conn.setRequestProperty("Accept", "application/json")
                try {
                    val code = conn.responseCode
                    if (code == 404) throw NotFound()
                    if (code in 200..299) return@withContext conn.inputStream.bufferedReader().use { it.readText() }
                    last = IOException("HTTP $code")
                } finally {
                    conn.disconnect()
                }
            } catch (e: NotFound) {
                throw e
            } catch (e: Exception) {
                last = e
            }
            delay(600L * (attempt + 1))
        }
        throw last
    }

    suspend fun sets(): List<CardReader.SetInfo> {
        sets?.let { return it }
        val cachedAt = prefs.getLong("setsAt", 0)
        val cached = prefs.getString("sets", null)
        if (cached != null && System.currentTimeMillis() - cachedAt < 3L * 24 * 60 * 60 * 1000) {
            return parseSets(JSONArray(cached)).also { sets = it }
        }
        return try {
            val json = get("$api/sets")
            prefs.edit().putString("sets", json).putLong("setsAt", System.currentTimeMillis()).apply()
            parseSets(JSONArray(json)).also { sets = it }
        } catch (e: Exception) {
            cached?.let { parseSets(JSONArray(it)) } ?: emptyList()
        }
    }

    private fun parseSets(arr: JSONArray) = (0 until arr.length()).map {
        val o = arr.getJSONObject(it)
        val count = o.optJSONObject("cardCount")
        CardReader.SetInfo(
            o.getString("id"),
            o.optString("name").ifEmpty { null },
            count?.optInt("official", -1)?.takeIf { n -> n > 0 },
        )
    }

    suspend fun normaliseSetId(input: String): String =
        sets().firstOrNull { it.id.equals(input, ignoreCase = true) }?.id ?: input

    /** The card, or null if TCGdex has no such card. Throws IOException when offline. */
    suspend fun card(setInput: String, number: String): Card? {
        val setId = normaliseSetId(setInput)
        val key = "$setId-${number.trimStart('0')}".lowercase()
        cards[key]?.let { return it }
        if (key in missing) return null
        for (localId in CardReader.localIds(number)) {
            try {
                val json = get("$api/cards/${URLEncoder.encode("$setId-$localId", "UTF-8")}")
                return parseCard(JSONObject(json)).also { cards[key] = it }
            } catch (e: NotFound) {
                // try the next spelling of the number
            }
        }
        missing += key
        return null
    }

    fun forget(setId: String, number: String) {
        cards.remove("$setId-${number.trimStart('0')}".lowercase())
    }

    /**
     * Check readings against the database. Readings where the set code was read are tried
     * in order. Readings based only on the card count are checked all at once; if several
     * are real cards, the Japanese name the camera read picks between them, otherwise the
     * person chooses.
     */
    suspend fun resolve(readings: List<CardReader.Reading>, japaneseText: String, allowChoices: Boolean): Match {
        if (readings.isEmpty()) return Match.None
        try {
            for (r in readings.filter { it.via != "total" }.take(4)) {
                card(r.setId, r.number)?.let { return Match.Found(it) }
            }
            val weak = readings.filter { it.via == "total" }.take(16)
            if (weak.isEmpty()) return Match.None
            val found = coroutineScope {
                weak.map { r -> async { card(r.setId, r.number) } }.awaitAll().filterNotNull()
            }
            if (found.size == 1) return Match.Found(found[0])
            if (found.size > 1) {
                val seen = CardReader.squash(japaneseText)
                val byName = found.filter { it.name.isNotBlank() && seen.contains(CardReader.squash(it.name)) }
                if (byName.size == 1) return Match.Found(byName[0])
                if (allowChoices) return Match.Choices(if (byName.size > 1) byName else found)
            }
            return Match.None
        } catch (e: IOException) {
            return Match.Offline(readings[0])
        }
    }

    suspend fun image(card: Card, quality: String = "high"): Bitmap? = withContext(Dispatchers.IO) {
        val base = card.image ?: return@withContext null
        for (ext in listOf("webp", "png")) {
            try {
                URL("$base/$quality.$ext").openStream().use { s -> BitmapFactory.decodeStream(s)?.let { return@withContext it } }
            } catch (_: Exception) {
            }
        }
        null
    }

    private fun parseCard(o: JSONObject): Card {
        val set = o.optJSONObject("set")
        return Card(
            id = o.optString("id"),
            localId = o.optString("localId"),
            name = o.optString("name"),
            rarity = o.optString("rarity").ifEmpty { null }?.takeIf { it != "null" },
            image = o.optString("image").ifEmpty { null }?.takeIf { it != "null" },
            setId = set?.optString("id") ?: o.optString("id").substringBeforeLast('-'),
            setName = set?.optString("name")?.ifEmpty { null },
            official = set?.optJSONObject("cardCount")?.optInt("official", -1)?.takeIf { it > 0 },
            prices = parsePrices(o.optJSONObject("pricing")),
        )
    }

    private fun num(o: JSONObject?, key: String): Double? =
        o?.optDouble(key, Double.NaN)?.takeIf { !it.isNaN() && it > 0 }

    private fun parsePrices(p: JSONObject?): List<PriceBlock> {
        val out = mutableListOf<PriceBlock>()
        val cm = p?.optJSONObject("cardmarket")
        if (cm != null) {
            val holo = num(cm, "trend") == null && num(cm, "trend-holo") != null
            fun k(name: String) = num(cm, if (holo) "$name-holo" else name)
            val main = k("trend") ?: k("avg")
            if (main != null) {
                val detail = listOfNotNull(
                    k("avg30")?.let { "30-day average ${Money.eur(it)}" },
                    k("low")?.let { "lowest listing ${Money.eur(it)}" },
                ).joinToString(" · ")
                out += PriceBlock("Cardmarket trend price", Money.eur(main), detail, cm.optString("updated").ifEmpty { null })
            }
        }
        val tp = p?.optJSONObject("tcgplayer")
        if (tp != null) {
            val variants = listOf("normal" to "", "holofoil" to " (holo)", "holo" to " (holo)", "reverse-holofoil" to " (reverse holo)", "reverse" to " (reverse holo)")
            for ((key, label) in variants) {
                val v = tp.optJSONObject(key) ?: continue
                val main = num(v, "marketPrice") ?: num(v, "midPrice") ?: continue
                val lo = num(v, "lowPrice")
                val hi = num(v, "highPrice")
                val detail = if (lo != null && hi != null) "listings ${Money.usd(lo)} – ${Money.usd(hi)}" else ""
                out += PriceBlock("TCGplayer market price$label", Money.usd(main), detail, tp.optString("updated").ifEmpty { null })
                break
            }
        }
        return out
    }
}

object Money {
    private fun fmt(code: String, v: Double): String {
        val f = java.text.NumberFormat.getCurrencyInstance()
        f.currency = java.util.Currency.getInstance(code)
        return f.format(v)
    }
    fun eur(v: Double) = fmt("EUR", v)
    fun usd(v: Double) = fmt("USD", v)
}
