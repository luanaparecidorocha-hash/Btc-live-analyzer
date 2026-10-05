package expo.modules.btcscreencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.DisplayMetrics
import android.view.Display
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

class ScreenCaptureService : Service() {
  private var projection: MediaProjection? = null
  private var virtualDisplay: android.hardware.display.VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var executor: ExecutorService? = null
  private var started = false
  private var cleaningUp = false

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    executor = Executors.newSingleThreadExecutor()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      emitState("ERRO", "O serviço foi reiniciado sem a autorização MediaProjection.")
      stopSelf()
      return START_NOT_STICKY
    }

    val notification = createNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    if (!started) {
      startProjection(intent)
    }
    return START_STICKY
  }

  private fun startProjection(intent: Intent) {
    val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, -1)
    val resultData = intent.parcelableExtraCompat<Intent>(EXTRA_RESULT_DATA)
    if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
      emitState("ERRO", "Dados inválidos para iniciar a captura MediaProjection.")
      stopSelf()
      return
    }

    val metrics = DisplayMetrics()
    val windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
    @Suppress("DEPRECATION")
    windowManager.defaultDisplay.getRealMetrics(metrics)
    val width = max(1, metrics.widthPixels)
    val height = max(1, metrics.heightPixels)
    val density = max(1, metrics.densityDpi)

    val region = CaptureRegion(
      left = intent.getFloatExtra(EXTRA_REGION_LEFT, 8f),
      top = intent.getFloatExtra(EXTRA_REGION_TOP, 24f),
      width = intent.getFloatExtra(EXTRA_REGION_WIDTH, 84f),
      height = intent.getFloatExtra(EXTRA_REGION_HEIGHT, 48f)
    )

    try {
      val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      projection = manager.getMediaProjection(resultCode, resultData)
      if (projection == null) throw IllegalStateException("O Android não forneceu uma sessão MediaProjection.")

      imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
      imageReader?.setOnImageAvailableListener({ reader ->
        val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
        executor?.execute {
          try {
            processImage(image, width, height, region)
          } finally {
            image.close()
          }
        }
      }, null)

      projection?.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() {
          if (cleaningUp) return
          cleanupProjection()
          emitState("DESATIVADA", "A sessão de captura foi encerrada pelo Android.")
          stopSelf()
        }
      }, null)

      virtualDisplay = projection?.createVirtualDisplay(
        "BTC Live Analyzer",
        width,
        height,
        density,
        android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        imageReader?.surface,
        null,
        null
      )
      started = true
      currentState = mapOf<String, Any>("status" to "ATIVA")
      emitState("ATIVA", null)
    } catch (error: Exception) {
      emitState("ERRO", error.message ?: "Erro desconhecido ao iniciar a captura.")
      cleanupProjection()
      stopSelf()
    }
  }

  private fun processImage(image: Image, screenWidth: Int, screenHeight: Int, region: CaptureRegion) {
    val plane = image.planes.firstOrNull() ?: return
    val buffer: ByteBuffer = plane.buffer
    val pixelStride = plane.pixelStride
    val rowStride = plane.rowStride
    val left = (screenWidth * (region.left / 100f)).toInt().coerceIn(0, screenWidth - 1)
    val top = (screenHeight * (region.top / 100f)).toInt().coerceIn(0, screenHeight - 1)
    val right = (screenWidth * ((region.left + region.width) / 100f)).toInt().coerceIn(left + 1, screenWidth)
    val bottom = (screenHeight * ((region.top + region.height) / 100f)).toInt().coerceIn(top + 1, screenHeight)
    val stepX = max(2, (right - left) / 180)
    val stepY = max(2, (bottom - top) / 120)

    var weightedY = 0.0
    var candidatePixels = 0
    var lumaTotal = 0L
    var sampledPixels = 0

    for (y in top until bottom step stepY) {
      for (x in left until right step stepX) {
        val offset = y * rowStride + x * pixelStride
        if (offset < 0 || offset + 2 >= buffer.limit()) continue
        val red = buffer.get(offset).toInt() and 0xFF
        val green = buffer.get(offset + 1).toInt() and 0xFF
        val blue = buffer.get(offset + 2).toInt() and 0xFF
        val luma = (red + green + blue) / 3
        lumaTotal += luma
        sampledPixels += 1

        // Only bright, high-contrast pixels are treated as chart marks.
        // If the selected region has no such pixels, no frame is emitted.
        if (luma >= 145 && max(red, max(green, blue)) - min(red, min(green, blue)) >= 18) {
          weightedY += y.toDouble()
          candidatePixels += 1
        }
      }
    }

    if (candidatePixels < MIN_CANDIDATE_PIXELS || sampledPixels == 0) return

    val centerY = weightedY / candidatePixels.toDouble()
    val normalizedPosition = 1f - ((centerY - top) / max(1f, (bottom - top).toFloat()))
    eventSink?.invoke("onFrame", mapOf(
      "timestamp" to System.currentTimeMillis(),
      "position" to normalizedPosition.coerceIn(0.0, 1.0),
      "meanLuma" to (lumaTotal.toFloat() / sampledPixels.toFloat()),
      "candidatePixels" to candidatePixels
    ))
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Captura BTC", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Indica que a captura MediaProjection está ativa."
        setShowBadge(false)
      }
    )
  }

  private fun createNotification(): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle("BTC Live Analyzer")
      .setContentText("Captura de tela ativa; os frames são processados somente no dispositivo.")
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(pendingIntent)
      .build()
  }

  private fun emitState(status: String, message: String?) {
    val state = buildMap<String, Any> {
      put("status", status)
      if (message != null) put("message", message)
    }
    currentState = state
    eventSink?.invoke("onCaptureStateChanged", state)
  }

  private fun cleanupProjection() {
    cleaningUp = true
    try {
      started = false
      virtualDisplay?.release()
      virtualDisplay = null
      imageReader?.close()
      imageReader = null
      val activeProjection = projection
      projection = null
      activeProjection?.stop()
    } finally {
      cleaningUp = false
    }
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The service deliberately remains alive when the user dismisses the app.
    // Android can stop it under resource pressure; START_STICKY then reports
    // an explicit error instead of silently fabricating a new capture session.
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    val wasRunning = started
    cleanupProjection()
    executor?.shutdownNow()
    executor = null
    if (wasRunning && currentState?.get("status") != "DESATIVADA") {
      emitState("DESATIVADA", "A captura foi interrompida.")
    }
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private data class CaptureRegion(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float
  )

  companion object {
    const val EXTRA_RESULT_CODE = "btc_capture_result_code"
    const val EXTRA_RESULT_DATA = "btc_capture_result_data"
    const val EXTRA_REGION_LEFT = "btc_capture_region_left"
    const val EXTRA_REGION_TOP = "btc_capture_region_top"
    const val EXTRA_REGION_WIDTH = "btc_capture_region_width"
    const val EXTRA_REGION_HEIGHT = "btc_capture_region_height"
    private const val CHANNEL_ID = "btc-capture"
    private const val NOTIFICATION_ID = 7314
    private const val MIN_CANDIDATE_PIXELS = 3

    @Volatile
    var currentState: Map<String, Any>? = null

    @Volatile
    var eventSink: ((String, Map<String, Any>) -> Unit)? = null
  }
}

private inline fun <reified T : android.os.Parcelable> Intent.parcelableExtraCompat(key: String): T? =
  if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(key, T::class.java) else @Suppress("DEPRECATION") getParcelableExtra(key)