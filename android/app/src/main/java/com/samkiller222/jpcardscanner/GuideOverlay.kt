package com.samkiller222.jpcardscanner

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View

/** Card-shaped frame drawn over the camera, with the code area at the bottom marked. */
class GuideOverlay @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private val density = resources.displayMetrics.density
    private val shade = Paint().apply { color = Color.argb(130, 0, 0, 0) }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 3 * density
    }
    private val codeLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 210, 87); style = Paint.Style.STROKE; strokeWidth = 2 * density
        pathEffect = DashPathEffect(floatArrayOf(8 * density, 6 * density), 0f)
    }
    private val codeFill = Paint().apply { color = Color.argb(30, 255, 210, 87) }
    private val labelBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(160, 0, 0, 0) }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(255, 210, 87); textSize = 12 * density; isFakeBoldText = true
    }
    private val frame = RectF()
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val fw = minOf(w * 0.78f, h * 0.7f * 63f / 88f)
        val fh = fw * 88f / 63f
        frame.set((w - fw) / 2, (h - fh) / 2, (w + fw) / 2, (h + fh) / 2)
        val r = fw * 0.045f

        path.reset()
        path.fillType = Path.FillType.EVEN_ODD
        path.addRect(0f, 0f, w, h, Path.Direction.CW)
        path.addRoundRect(frame, r, r, Path.Direction.CW)
        canvas.drawPath(path, shade)

        val codeTop = frame.bottom - fh * 0.14f
        canvas.drawRect(frame.left, codeTop, frame.right, frame.bottom, codeFill)
        canvas.drawLine(frame.left, codeTop, frame.right, codeTop, codeLine)
        canvas.drawRoundRect(frame, r, r, border)

        val text = "code here"
        val pad = 6 * density
        val tw = label.measureText(text)
        val ty = codeTop - pad
        canvas.drawRoundRect(frame.left + pad, ty - label.textSize - pad / 2, frame.left + pad * 3 + tw, ty + pad / 2, pad, pad, labelBg)
        canvas.drawText(text, frame.left + pad * 2, ty - pad / 4, label)
    }
}
