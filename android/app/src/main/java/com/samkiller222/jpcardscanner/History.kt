package com.samkiller222.jpcardscanner

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class HistoryItem(val setId: String, val number: String, val name: String, val rarity: String?, val price: String?)

/** Recent scans, kept on this phone only. */
class History(context: Context) {
    private val prefs = context.getSharedPreferences("history", Context.MODE_PRIVATE)

    fun all(): List<HistoryItem> {
        val arr = try { JSONArray(prefs.getString("items", "[]")) } catch (_: Exception) { JSONArray() }
        return (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            HistoryItem(
                o.optString("setId"), o.optString("number"), o.optString("name"),
                o.optString("rarity").ifEmpty { null }, o.optString("price").ifEmpty { null },
            )
        }
    }

    fun add(card: Card) {
        val item = HistoryItem(card.setId, card.localId, card.name, card.rarity, card.prices.firstOrNull()?.main)
        val items = listOf(item) + all().filterNot { it.setId == item.setId && it.number == item.number }
        save(items.take(50))
    }

    fun clear() = save(emptyList())

    private fun save(items: List<HistoryItem>) {
        val arr = JSONArray()
        for (i in items) {
            arr.put(JSONObject().apply {
                put("setId", i.setId); put("number", i.number); put("name", i.name)
                put("rarity", i.rarity ?: ""); put("price", i.price ?: "")
            })
        }
        prefs.edit().putString("items", arr.toString()).apply()
    }
}
