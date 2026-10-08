package com.samkiller222.jpcardscanner

import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.tasks.await

/** Reads text on the phone with Google ML Kit: Latin for the card code, Japanese for the card name. */
class TextReaders {
    val latin = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    val japanese = TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())

    suspend fun read(image: InputImage): Pair<String, String> {
        val l = runCatching { latin.process(image).await().text }.getOrDefault("")
        val j = runCatching { japanese.process(image).await().text }.getOrDefault("")
        return l to j
    }

    fun close() {
        latin.close()
        japanese.close()
    }
}

/** Runs the readers on camera frames, one frame at a time. */
class TextAnalyzer(
    private val readers: TextReaders,
    private val onText: (latin: String, japanese: String) -> Unit,
) : ImageAnalysis.Analyzer {
    @Volatile var paused = false
    private var frame = 0

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    override fun analyze(proxy: ImageProxy) {
        val media = proxy.image
        if (paused || media == null) {
            proxy.close()
            return
        }
        val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        // The Japanese reader is slower; run it on every other frame for the card name.
        val withJapanese = frame++ % 2 == 0
        val tasks = mutableListOf<Task<Text>>(readers.latin.process(image))
        if (withJapanese) tasks += readers.japanese.process(image)
        Tasks.whenAllComplete(tasks).addOnCompleteListener {
            val latin = tasks[0].takeIf { it.isSuccessful }?.result?.text.orEmpty()
            val japanese = if (withJapanese) tasks[1].takeIf { it.isSuccessful }?.result?.text.orEmpty() else ""
            proxy.close()
            if (!paused) onText(latin, japanese)
        }
    }
}
