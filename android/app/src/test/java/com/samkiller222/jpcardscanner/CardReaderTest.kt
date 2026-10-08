package com.samkiller222.jpcardscanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CardReaderTest {
    private val sets = listOf(
        CardReader.SetInfo("SV2a", "151", 165),
        CardReader.SetInfo("S12a", null, 172),
        CardReader.SetInfo("SM12a", null, 173),
        CardReader.SetInfo("SV8a", null, 187),
        CardReader.SetInfo("SV4M", null, 66),
        CardReader.SetInfo("SV4K", null, 66),
        CardReader.SetInfo("BW2", null, 66),
        CardReader.SetInfo("SM5M", null, 66),
        CardReader.SetInfo("SV-P", null, null),
    )

    private fun first(text: String) = CardReader.readings(text, sets).first()

    @Test fun readsPlainCode() = assertEquals(CardReader.Reading("SV2a", "205", "code"), first("G sv2a 205/165 UR"))

    @Test fun fixesLetterDigitMixUps() {
        assertEquals("205", first("G SV2a 2O5/165 UR").number)
        assertEquals("SV2a", first("G 5V2a 205 / 165 UR").setId)
        assertEquals("SV2a", first("G SVZa 205/165").setId)
        assertEquals("008", first("SM12a 0O8/173 C").number)
    }

    @Test fun usesTotalWhenSetCodeMissing() {
        val r = first("205/165")
        assertEquals("SV2a", r.setId)
        assertEquals("total", r.via)
    }

    @Test fun readsSlashMisreadAsSeven() {
        val list = CardReader.readings("G BELLY 0707066 AR", sets)
        assertTrue(list.any { it.setId == "SV4M" && it.number == "070" })
    }

    @Test fun ranksByPartlyReadSetCode() {
        val list = CardReader.readings("0707066", sets)
        val ranked = CardReader.rankByHint(list, listOf("Bsv", "Rsv"))
        assertEquals(setOf("SV4M", "SV4K"), ranked.map { it.setId }.toSet())
    }

    @Test fun readsPromo() = assertEquals(CardReader.Reading("SV-P", "001", "code"), first("001/SV-P"))

    @Test fun padsLocalIds() {
        assertEquals(listOf("005", "5"), CardReader.localIds("5"))
        assertEquals(listOf("205"), CardReader.localIds("205"))
        assertEquals(listOf("070", "70"), CardReader.localIds("070"))
    }

    @Test fun ignoresNoise() = assertTrue(CardReader.readings("garbage only", sets).isEmpty())
}
