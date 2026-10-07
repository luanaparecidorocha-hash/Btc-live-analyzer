package expo.modules.btcscreencapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

class ScreenCaptureService : Service() {
  private val captureLock = Any()
  private var projection: MediaProjection? = null
  private var projectionCallback: MediaProjection.Callback? = null
  private var virtualDisplay: android.hardware.display.VirtualDisplay? = null
  private var imageReader: ImageReader? = null
  private var captureThread: HandlerThread? = null
  private var captureHandler: Handler? = null
  @Volatile
  private var started = false
  private var cleaningUp = false
  private var lastProcessedAt = 0L
  @Volatile private var userStopped = false
  private var readFailures = 0
  private val stopReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action != ACTION_STOP_CAPTURE) return
      userStopped = true
      emitState("DESATIVADA", null)
      getSystemService(NotificationManager::class.java).cancel(INTERRUPTED_ID)
      stopSelf()
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    createNotificationChannel()
    ContextCompat.registerReceiver(this, stopReceiver, IntentFilter(ACTION_STOP_CAPTURE), ContextCompat.RECEIVER_NOT_EXPORTED)
    captureThread = HandlerThread("BtcScreenCapture").apply { start() }
    captureHandler = Handler(captureThread!!.looper)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      reportInterruption("O serviço foi reiniciado sem autorização. Abra o app e inicie a captura novamente.")
      stopSelf()
      return START_NOT_STICKY
    }

    try {
      val notification = createNotification()
      getSystemService(NotificationManager::class.java).cancel(INTERRUPTED_ID)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      if (!started) startProjection(intent)
    } catch (error: Exception) {
      reportInterruption("Não foi possível manter o serviço de captura: ${error.message}")
      cleanupProjection()
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  private fun startProjection(intent: Intent) {
    val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, -1)
    val resultData = intent.parcelableExtraCompat<Intent>(EXTRA_RESULT_DATA)
    if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
      reportInterruption("Dados inválidos para iniciar a captura MediaProjection.")
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
      synchronized(captureLock) {
        val handler = captureHandler ?: throw IllegalStateException("Thread de captura indisponível.")
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val activeProjection = manager.getMediaProjection(resultCode, resultData)
          ?: throw IllegalStateException("O Android não forneceu uma sessão MediaProjection.")
        projection = activeProjection

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ availableReader ->
          consumeLatestImage(availableReader, width, height, region)
        }, handler)

        val callback = object : MediaProjection.Callback() {
          override fun onStop() {
            // Ignore delayed callbacks from a projection already released by us.
            synchronized(captureLock) {
              if (cleaningUp || projection !== activeProjection) return
            }
            cleanupProjection()
            reportInterruption("O Android interrompeu a captura. Abra o app e inicie novamente para autorizar uma nova sessão.")
            stopSelf()
          }

          override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
            synchronized(captureLock) {
              if (!started || cleaningUp || projection !== activeProjection) return
            }
            val message = if (isVisible) null else "O conteúdo capturado não está visível. A captura está pausada pelo Android."
            emitState(if (isVisible) "ATIVA" else "ERRO", message)
            getSystemService(NotificationManager::class.java).notify(
              NOTIFICATION_ID, createNotification(message)
            )
          }
        }
        projectionCallback = callback
        activeProjection.registerCallback(callback, Handler(Looper.getMainLooper()))

        virtualDisplay = activeProjection.createVirtualDisplay(
          "BTC Live Analyzer",
          width,
          height,
          density,
          android.hardware.display.DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
          reader.surface,
          null,
          null
        ) ?: throw IllegalStateException("O Android não forneceu um VirtualDisplay.")
        started = true
      }
      currentState = mapOf<String, Any>("status" to "ATIVA")
      emitState("ATIVA", null)
    } catch (error: Exception) {
      reportInterruption(error.message ?: "Erro desconhecido ao iniciar a captura.")
      cleanupProjection()
      stopSelf()
    }
  }

  private fun consumeLatestImage(reader: ImageReader, width: Int, height: Int, region: CaptureRegion) {
    val frame = synchronized(captureLock) {
      // Serializes acquisition with shutdown, including callbacks queued before STOP.
      if (!started || cleaningUp || reader !== imageReader) return
      var image: Image? = null
      try {
        image = reader.acquireLatestImage() ?: return
        processImage(image, width, height, region).also { readFailures = 0 }
      } catch (error: Exception) {
        readFailures += 1
        Log.w(TAG, "Falha ao ler/processar um frame de captura.", error)
        null
      } finally {
        image?.close()
      }
    }
    if (readFailures >= 3) {
      reportInterruption("Falha ao ler a captura. Abra o app e inicie novamente.")
      cleanupProjection()
      stopSelf()
      return
    }
    // Only copied scalar results cross the bridge; no Image/plane/buffer escapes.
    // The Image is already closed, even if the bridge queues work asynchronously.
    if (frame != null && started) {
      try {
        eventSink?.invoke("onFrame", frame)
      } catch (error: Exception) {
        Log.w(TAG, "Falha ao entregar o resultado do frame de captura.", error)
      }
    }
  }

  private fun processImage(image: Image, screenWidth: Int, screenHeight: Int, region: CaptureRegion): Map<String, Any>? {
    // Always acquire/close available Images, but avoid scanning/bridging every
    // display refresh. This does not change price analysis or five-minute cycles.
    val now = SystemClock.elapsedRealtime()
    if (lastProcessedAt != 0L && now - lastProcessedAt < FRAME_INTERVAL_MS) return null
    lastProcessedAt = now
    val plane = image.planes.firstOrNull() ?: return null
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

    if (candidatePixels < MIN_CANDIDATE_PIXELS || sampledPixels == 0) return null

    val centerY = weightedY / candidatePixels.toDouble()
    val normalizedPosition = 1f - ((centerY - top) / max(1f, (bottom - top).toFloat()))
    return mapOf(
      "timestamp" to System.currentTimeMillis(),
      "position" to normalizedPosition.coerceIn(0.0, 1.0),
      "meanLuma" to (lumaTotal.toFloat() / sampledPixels.toFloat()),
      "candidatePixels" to candidatePixels
    )
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

  private fun createNotification(message: String? = null): Notification {
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
      .setContentText(message ?: "Captura de tela ativa; os frames são processados somente no dispositivo.")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
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
    try {
      eventSink?.invoke("onCaptureStateChanged", state)
    } catch (error: Exception) {
      Log.w(TAG, "Estado de captura retido para a próxima abertura do app.", error)
    }
  }

  private fun reportInterruption(message: String) {
    emitState("ERRO", message)
    val warning = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle("BTC · captura interrompida")
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setContentIntent(createNotification().contentIntent)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .build()
    getSystemService(NotificationManager::class.java).notify(INTERRUPTED_ID, warning)
  }

  private fun cleanupProjection() {
    synchronized(captureLock) {
      if (cleaningUp) return
      cleaningUp = true
      started = false
      val activeDisplay = virtualDisplay
      val activeReader = imageReader
      val activeProjection = projection
      val activeCallback = projectionCallback
      virtualDisplay = null
      imageReader = null
      projection = null
      projectionCallback = null
      try {
        // No acquired Image remains: processing and its finally share this lock.
        releaseCaptureResource("listener") { activeReader?.setOnImageAvailableListener(null, null) }
        releaseCaptureResource("VirtualDisplay") { activeDisplay?.release() }
        releaseCaptureResource("ImageReader") { activeReader?.close() }
        releaseCaptureResource("callback MediaProjection") {
          if (activeProjection != null && activeCallback != null) activeProjection.unregisterCallback(activeCallback)
        }
        releaseCaptureResource("MediaProjection") { activeProjection?.stop() }
      } finally {
        cleaningUp = false
      }
    }
  }

  private fun releaseCaptureResource(name: String, release: () -> Unit) {
    try {
      release()
    } catch (error: Exception) {
      // A failed release must not prevent the remaining resources being closed.
      Log.w(TAG, "Falha ao liberar $name.", error)
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
    captureHandler?.removeCallbacksAndMessages(null)
    captureHandler = null
    captureThread?.quitSafely()
    captureThread = null
    unregisterReceiver(stopReceiver)
    if (wasRunning && !userStopped) {
      reportInterruption("O serviço de captura foi interrompido. Abra o app e inicie novamente.")
    }
    if (instance === this) instance = null
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
    private const val TAG = "BtcScreenCapture"
    const val EXTRA_RESULT_CODE = "btc_capture_result_code"
    const val EXTRA_RESULT_DATA = "btc_capture_result_data"
    const val EXTRA_REGION_LEFT = "btc_capture_region_left"
    const val EXTRA_REGION_TOP = "btc_capture_region_top"
    const val EXTRA_REGION_WIDTH = "btc_capture_region_width"
    const val EXTRA_REGION_HEIGHT = "btc_capture_region_height"
    private const val CHANNEL_ID = "btc-capture"
    private const val NOTIFICATION_ID = 7314
    private const val INTERRUPTED_ID = 7315
    private const val FRAME_INTERVAL_MS = 1000L
    const val ACTION_STOP_CAPTURE = "com.btcliveanalyzer.STOP_CAPTURE"
    private const val MIN_CANDIDATE_PIXELS = 3

    @Volatile
    var currentState: Map<String, Any>? = null

    @Volatile
    var eventSink: ((String, Map<String, Any>) -> Unit)? = null
    @Volatile private var instance: ScreenCaptureService? = null

    fun requestStop(context: Context) {
      // Package-private receiver: no Activity or JS runtime is needed to stop.
      currentState = mapOf("status" to "DESATIVADA")
      instance?.userStopped = true
      context.getSystemService(NotificationManager::class.java).cancel(INTERRUPTED_ID)
      context.stopService(Intent(context, ScreenCaptureService::class.java))
    }
  }
}

private inline fun <reified T : android.os.Parcelable> Intent.parcelableExtraCompat(key: String): T? =
  if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(key, T::class.java) else @Suppress("DEPRECATION") getParcelableExtra(key)