package com.samkiller222.jpcardscanner

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Size
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.google.android.material.chip.Chip
import com.google.mlkit.vision.common.InputImage
import com.samkiller222.jpcardscanner.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var b: ActivityMainBinding
    private lateinit var tcgdex: Tcgdex
    private lateinit var history: History
    private val readers by lazy { TextReaders() }
    private lateinit var analysisExecutor: ExecutorService
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var analyzer: TextAnalyzer? = null

    private var sets: List<CardReader.SetInfo> = emptyList()
    private var scanning = false
    private var resolving = false
    private var lastKey: String? = null
    private var sameCount = 0
    private var framesWithoutCode = 0
    private val recentTexts = ArrayDeque<String>()
    private val recentJapanese = ArrayDeque<String>()

    /** Photo of the scanned card, shared with "Ask Claude". */
    private var shareFile: File? = null
    private var shownCard: Card? = null

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else {
            b.scanStatus.text = "Camera access is off. Allow it in Settings, or use Photo or Type code."
        }
    }

    private val pickPhoto = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) readPhoto(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        tcgdex = Tcgdex(this)
        history = History(this)
        analysisExecutor = Executors.newSingleThreadExecutor()

        lifecycleScope.launch { sets = tcgdex.sets() }

        b.photoButton.setOnClickListener {
            pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        b.typeButton.setOnClickListener { showResults(clear = true); b.setInput.requestFocus() }
        b.scanAgain.setOnClickListener { showScanner() }
        b.lookupButton.setOnClickListener { lookupTyped() }
        b.clearHistory.setOnClickListener { history.clear(); renderHistory() }
        b.torchButton.setOnClickListener { camera?.cameraControl?.enableTorch(b.torchButton.isChecked) }
        b.askClaude.setOnClickListener { askClaude(shownCard) }
        setupTapToFocus()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (b.resultLayer.visibility == View.VISIBLE) showScanner() else finish()
            }
        })

        renderHistory()
        showScanner()
    }

    override fun onDestroy() {
        super.onDestroy()
        analysisExecutor.shutdown()
        readers.close()
    }

    // ---------- camera ----------

    private fun showScanner() {
        b.resultLayer.visibility = View.GONE
        b.scanLayer.visibility = View.VISIBLE
        lastKey = null
        sameCount = 0
        framesWithoutCode = 0
        recentTexts.clear()
        recentJapanese.clear()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        b.scanStatus.text = "Starting the camera…"
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = try { future.get() } catch (e: Exception) {
                b.scanStatus.text = "Couldn't start the camera. Use Photo or Type code instead."
                return@addListener
            }
            cameraProvider = provider
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(b.preview.surfaceProvider) }
            val selector = ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(Size(1920, 1080), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build()
            val textAnalyzer = TextAnalyzer(readers) { latin, japanese -> onFrameText(latin, japanese) }
            analyzer = textAnalyzer
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(selector)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { it.setAnalyzer(analysisExecutor, textAnalyzer) }
            try {
                provider.unbindAll()
                camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                val hasTorch = camera?.cameraInfo?.hasFlashUnit() == true
                b.torchButton.visibility = if (hasTorch) View.VISIBLE else View.GONE
                b.torchButton.isChecked = false
                scanning = true
                b.scanStatus.text = "Fit the card in the frame"
            } catch (e: Exception) {
                b.scanStatus.text = "Couldn't start the camera. Use Photo or Type code instead."
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun stopCamera() {
        scanning = false
        analyzer?.paused = true
        cameraProvider?.unbindAll()
        camera = null
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupTapToFocus() {
        b.preview.setOnTouchListener { v, event ->
            if (event.action == MotionEvent.ACTION_UP) {
                val point = b.preview.meteringPointFactory.createPoint(event.x, event.y)
                camera?.cameraControl?.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
                v.performClick()
            }
            true
        }
    }

    /** Called with the text read from each camera frame. */
    private fun onFrameText(latin: String, japanese: String) {
        if (!scanning || resolving || sets.isEmpty()) return
        val text = "$latin\n$japanese"
        recentTexts.addLast(text); while (recentTexts.size > 6) recentTexts.removeFirst()
        if (japanese.isNotBlank()) {
            recentJapanese.addLast(japanese); while (recentJapanese.size > 4) recentJapanese.removeFirst()
        }
        val list = CardReader.readings(text, sets)
        if (list.isEmpty()) {
            framesWithoutCode++
            b.scanStatus.text = if (framesWithoutCode > 25) {
                "Move closer so the code at the bottom is sharp. Tap the screen to focus."
            } else "Fit the card in the frame"
            return
        }
        framesWithoutCode = 0
        val top = list[0]
        val key = if (top.via == "total") "${top.number}/?" else "${top.setId} ${top.number}"
        sameCount = if (key == lastKey) sameCount + 1 else 0
        lastKey = key
        b.scanStatus.text = "Reading $key…"
        resolving = true
        lifecycleScope.launch {
            val ranked = CardReader.rankByHint(list, recentTexts.toList())
            // Only offer a choice of sets after a few frames of trying to read the set code.
            val match = tcgdex.resolve(ranked, recentJapanese.joinToString("\n"), allowChoices = sameCount >= 4)
            resolving = false
            if (!scanning) return@launch
            when (match) {
                is Match.Found, is Match.Choices -> accept(match)
                is Match.Offline -> if (sameCount >= 2) accept(match)
                Match.None -> Unit
            }
        }
    }

    private fun accept(match: Match) {
        b.root.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS,
        )
        val frame: Bitmap? = b.preview.bitmap
        stopCamera()
        shareFile = frame?.let { saveForSharing(it) }
        showMatch(match)
    }

    // ---------- photos ----------

    private fun readPhoto(uri: Uri) {
        stopCamera()
        showResults(clear = true)
        showMessage("Reading the photo…")
        lifecycleScope.launch {
            shareFile = copyForSharing(uri)
            val (latin, japanese) = try {
                readers.read(InputImage.fromFilePath(this@MainActivity, uri))
            } catch (e: IOException) {
                showMessage("Couldn't open that photo. Try another one.")
                return@launch
            }
            if (sets.isEmpty()) sets = tcgdex.sets()
            val text = "$latin\n$japanese"
            val list = CardReader.readings(text, sets)
            if (list.isEmpty()) {
                showMessage("Couldn't read the code in the bottom corner. Type it below, or try a closer, sharper photo.")
                return@launch
            }
            showMatch(tcgdex.resolve(CardReader.rankByHint(list, listOf(text)), japanese, allowChoices = true))
        }
    }

    private fun saveForSharing(bitmap: Bitmap): File? = try {
        File(cacheDir, "shared").mkdirs()
        File(cacheDir, "shared/card.jpg").also { f -> f.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) } }
    } catch (e: Exception) { null }

    private suspend fun copyForSharing(uri: Uri): File? = withContext(Dispatchers.IO) {
        try {
            File(cacheDir, "shared").mkdirs()
            val f = File(cacheDir, "shared/card.jpg")
            contentResolver.openInputStream(uri)?.use { input -> f.outputStream().use { input.copyTo(it) } }
            f
        } catch (e: Exception) { null }
    }

    // ---------- results ----------

    private fun showResults(clear: Boolean) {
        b.scanLayer.visibility = View.GONE
        b.resultLayer.visibility = View.VISIBLE
        if (clear) {
            b.cardPanel.visibility = View.GONE
            b.choicesPanel.visibility = View.GONE
            b.message.visibility = View.GONE
        }
        stopCamera()
    }

    private fun showMessage(text: String?) {
        b.message.text = text
        b.message.visibility = if (text.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun showMatch(match: Match) {
        showResults(clear = true)
        when (match) {
            is Match.Found -> showCard(match.card)
            is Match.Choices -> showChoices(match.cards)
            is Match.Offline -> {
                b.setInput.setText(match.reading.setId)
                b.numInput.setText(match.reading.number)
                showMessage("Read ${match.reading.setId} ${match.reading.number}, but couldn't reach the card database. Check your connection and tap Look up.")
            }
            Match.None -> showMessage("Couldn't match the code to a card. Check the code below and fix any wrong letter or digit.")
        }
        b.resultLayer.scrollTo(0, 0)
    }

    private fun showCard(card: Card) {
        shownCard = card
        showMessage(null)
        b.choicesPanel.visibility = View.GONE
        b.cardPanel.visibility = View.VISIBLE
        b.setInput.setText(card.setId)
        b.numInput.setText(card.localId)
        b.cardName.text = card.name.ifBlank { "${card.setId} ${card.localId}" }
        b.cardCode.text = "${card.setId}  ${card.localId}${card.official?.let { "/$it" } ?: ""}"
        b.cardRarity.text = card.rarity.orEmpty()
        b.cardRarity.visibility = if (card.rarity.isNullOrBlank()) View.GONE else View.VISIBLE
        b.cardSet.text = card.setName.orEmpty()

        b.cardImage.visibility = View.GONE
        b.cardImage.setImageDrawable(null)
        lifecycleScope.launch {
            val bmp = tcgdex.image(card)
            if (bmp != null && shownCard == card) {
                b.cardImage.setImageBitmap(bmp)
                b.cardImage.visibility = View.VISIBLE
            }
        }

        b.pricesBox.removeAllViews()
        if (card.prices.isEmpty()) {
            b.pricesBox.addView(priceView("Market price", "Not listed", "This card has no Cardmarket or TCGplayer price. Check the Japanese shops below."))
        } else {
            for (p in card.prices) b.pricesBox.addView(priceView(p.label, p.main, p.detail.ifBlank { null }, p.updated))
        }

        b.shopChips.removeAllViews()
        for ((label, url) in shopLinks(card.name, card.setId, card.localId)) {
            b.shopChips.addView(Chip(this).apply {
                text = "$label ↗"
                setOnClickListener { openUrl(url) }
            })
        }

        history.add(card)
        renderHistory()
    }

    private fun priceView(label: String, main: String, detail: String?, updated: String? = null): View {
        val v = LayoutInflater.from(this).inflate(R.layout.item_price, b.pricesBox, false)
        v.findViewById<TextView>(R.id.priceLabel).text = label
        v.findViewById<TextView>(R.id.priceMain).text = main
        val extra = listOfNotNull(detail, updated?.take(10)?.let { "Updated $it" }).joinToString("\n")
        v.findViewById<TextView>(R.id.priceDetail).apply {
            text = extra
            visibility = if (extra.isBlank()) View.GONE else View.VISIBLE
        }
        return v
    }

    private fun showChoices(cards: List<Card>) {
        b.cardPanel.visibility = View.GONE
        b.choicesPanel.visibility = View.VISIBLE
        b.numInput.setText(cards.first().localId)
        b.setInput.setText("")
        b.choicesRow.removeAllViews()
        for (card in cards) {
            val v = LayoutInflater.from(this).inflate(R.layout.item_choice, b.choicesRow, false)
            v.findViewById<TextView>(R.id.choiceName).text = card.name
            v.findViewById<TextView>(R.id.choiceCode).text = "${card.setId} ${card.localId}"
            val img = v.findViewById<ImageView>(R.id.choiceImage)
            lifecycleScope.launch { tcgdex.image(card, "low")?.let { img.setImageBitmap(it) } }
            v.setOnClickListener { showCard(card) }
            b.choicesRow.addView(v)
        }
    }

    private fun lookupTyped() {
        val set = b.setInput.text.toString().trim()
        val num = b.numInput.text.toString().trim().substringBefore('/')
        if (set.isEmpty() || num.isEmpty()) {
            showMessage("Enter both the set (like SV2a) and the card number (like 205).")
            return
        }
        lookup(set, num, fresh = false)
    }

    private fun lookup(set: String, number: String, fresh: Boolean) {
        showResults(clear = true)
        showMessage("Looking up $set $number…")
        lifecycleScope.launch {
            if (fresh) tcgdex.forget(set, number)
            val card = try { tcgdex.card(set, number) } catch (e: IOException) {
                showMessage("Couldn't reach the card database. Check your internet connection and try again.")
                return@launch
            }
            if (card == null) {
                showMessage("$set $number isn't in the free card database. Check the code, or search the shops:")
                b.cardPanel.visibility = View.GONE
                b.shopChips.removeAllViews()
                // Still offer shop searches for the typed code.
                b.choicesPanel.visibility = View.GONE
                showShopOnly(set, number)
            } else {
                shownCard = null
                showCard(card)
            }
        }
    }

    private fun showShopOnly(set: String, number: String) {
        b.cardPanel.visibility = View.VISIBLE
        b.cardImage.visibility = View.GONE
        b.cardName.text = "$set $number"
        b.cardCode.text = ""
        b.cardRarity.visibility = View.GONE
        b.cardSet.text = ""
        b.pricesBox.removeAllViews()
        for ((label, url) in shopLinks("", set, number)) {
            b.shopChips.addView(Chip(this).apply { text = "$label ↗"; setOnClickListener { openUrl(url) } })
        }
        shownCard = null
    }

    private fun shopLinks(name: String, setId: String, number: String): List<Pair<String, String>> {
        fun q(s: String) = URLEncoder.encode(s, "UTF-8")
        val ja = listOf(name, number).filter { it.isNotBlank() }.joinToString(" ")
        val en = "$setId $number japanese pokemon"
        return listOf(
            "Yuyu-tei 遊々亭" to "https://yuyu-tei.jp/sell/poc/s/search?search_word=${q(name.ifBlank { "$setId $number" })}",
            "Card Rush" to "https://www.cardrush-pokemon.jp/product-list?keyword=${q(ja)}",
            "SNKRDUNK" to "https://snkrdunk.com/search?keywords=${q(ja)}",
            "Mercari sold" to "https://jp.mercari.com/search?status=sold_out&keyword=${q(ja)}",
            "eBay sold" to "https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=${q(en)}",
        )
    }

    private fun openUrl(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No browser found", Toast.LENGTH_SHORT).show()
        }
    }

    // ---------- Ask Claude (shares to the Claude app, no API key) ----------

    private fun askClaude(card: Card?) {
        val code = card?.let { " I think it's ${it.setId} ${it.localId} (${it.name})." } ?: ""
        val prompt = "This is a Japanese Pokémon card.$code Please confirm the exact card: name in Japanese and English, " +
            "set, number, rarity, and anything that changes its value (promo stamp, reverse holo pattern, grading). " +
            "Then give me a rough current market value in yen and US dollars for a raw near-mint copy."
        // Copy first, in case the app drops the shared text.
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Question", prompt))

        val send = Intent(Intent.ACTION_SEND).apply {
            putExtra(Intent.EXTRA_TEXT, prompt)
            val file = shareFile
            if (file != null && file.exists()) {
                val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
                type = "image/jpeg"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri("Card photo", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } else {
                type = "text/plain"
            }
        }
        try {
            startActivity(Intent(send).setPackage("com.anthropic.claude"))
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent.createChooser(send, "Ask Claude about this card"))
        }
    }

    // ---------- history ----------

    private fun renderHistory() {
        val items = history.all()
        b.historyBox.removeAllViews()
        b.historyEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        b.clearHistory.visibility = if (items.isEmpty()) View.GONE else View.VISIBLE
        for (item in items) {
            val v = LayoutInflater.from(this).inflate(R.layout.item_history, b.historyBox, false)
            v.findViewById<TextView>(R.id.historyName).text = item.name.ifBlank { "Unknown" }
            v.findViewById<TextView>(R.id.historyCode).text =
                listOfNotNull(item.setId, item.number, item.rarity).joinToString(" · ")
            v.findViewById<TextView>(R.id.historyPrice).text = item.price ?: "—"
            v.setOnClickListener {
                shareFile = null
                lookup(item.setId, item.number, fresh = true) // fresh prices
            }
            b.historyBox.addView(v)
        }
    }
}

