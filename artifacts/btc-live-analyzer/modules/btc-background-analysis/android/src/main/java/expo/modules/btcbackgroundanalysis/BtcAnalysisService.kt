package expo.modules.btcbackgroundanalysis

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import org.json.JSONObject

class BtcAnalysisService : HeadlessJsTaskService() {
  private var taskStarted = false
  private var ownerToken = 0L

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      if (intent?.action == ACTION_STOP) {
        requestStop(this)
        return START_NOT_STICKY
      }
      if (taskStarted) return START_NOT_STICKY
      if (!active) {
        stopSelf()
        return START_NOT_STICKY
      }
      ownerToken = runToken
      createChannels(this)
      val stopIntent = Intent(this, BtcAnalysisService::class.java).setAction(ACTION_STOP)
      val stop = PendingIntent.getService(this, 2, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notification = NotificationCompat.Builder(this, RUNNING_CHANNEL)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("BTC · análise contínua ativa")
        .setContentText("Kraken + Binance em ciclos de 5 minutos. Toque para abrir o aplicativo.")
        .setContentIntent(openApp(this))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(android.R.drawable.ic_media_pause, "PARAR", stop)
        .build()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(RUNNING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(RUNNING_ID, notification)
      }
      taskStarted = true
      // RN owns the partial wake lock and keeps TimingModule active while this
      // Headless JS task is alive, including while the Activity is backgrounded.
      super.onStartCommand(intent, flags, startId)
    } catch (error: Exception) {
      Log.e("BtcAnalysisService", "Falha na inicialização do serviço foreground/Headless JS.", error)
      active = false
      try {
        requestStop(this, "Não foi possível iniciar o serviço Android: ${error.message}")
      } catch (cleanupError: Exception) {
        Log.e("BtcAnalysisService", "Falha ao comunicar/limpar a interrupção do serviço.", cleanupError)
      } finally {
        try {
          stopSelf()
        } catch (stopError: Exception) {
          Log.e("BtcAnalysisService", "Falha ao encerrar o serviço Android.", stopError)
        }
      }
    }
    // Do not silently restart after OS termination or user force-stop.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
    val data = Arguments.createMap()
    data.putDouble("runToken", ownerToken.toDouble())
    return HeadlessJsTaskConfig("BtcContinuousAnalysis", data, 0L, true)
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    // Android 15+ limits dataSync services to six background hours per 24h.
    requestStop(this, "O Android encerrou o período permitido de execução em segundo plano. Abra o app para iniciar novamente.")
  }

  override fun onDestroy() {
    try {
      endService(this, ownerToken)
    } catch (error: Exception) {
      Log.e("BtcAnalysisService", "Falha ao publicar o encerramento do serviço.", error)
    } finally {
      try {
        super.onDestroy()
      } catch (error: Exception) {
        Log.e("BtcAnalysisService", "Falha ao liberar os recursos Headless JS.", error)
      }
    }
  }

  companion object {
    const val ACTION_STOP = "com.btcliveanalyzer.STOP_ANALYSIS"
    const val RUNNING_CHANNEL = "btc-analysis-running"
    const val RESULT_CHANNEL = "btc-analysis-results"
    private const val RUNNING_ID = 8721
    private const val RESULT_ID = 8722
    @Volatile var active = false
    @Volatile var runToken = 0L
    @Volatile var snapshot: String? = null
    @Volatile var eventSink: ((String, Map<String, Any?>) -> Unit)? = null

    @Synchronized fun claimStart(): Boolean {
      if (active) return false
      active = true
      runToken += 1
      snapshot = null
      return true
    }

    @Synchronized fun publishSnapshot(json: String, token: Long) {
      if (token != runToken) return
      val state = JSONObject(json)
      if (!active) {
        state.put("isRunning", false)
        state.put("marketStatus", "DESATIVADA")
      }
      snapshot = state.toString()
      eventSink?.invoke("onAnalysisState", mapOf("json" to state.toString()))
    }

    @Synchronized fun endService(context: Context, token: Long) {
      val message = if (token == runToken && active) {
        "O serviço Android foi interrompido. Inicie novamente pelo aplicativo."
      } else "Serviço Android interrompido."
      if (token == runToken) {
        val unexpected = active
        active = false
        snapshot?.let {
          val state = JSONObject(it)
          state.put("isRunning", false)
          state.put("marketStatus", "DESATIVADA")
          if (unexpected) state.put("error", "O serviço Android foi interrompido. Inicie novamente pelo aplicativo.")
          snapshot = state.toString()
        }
        stopCapture(context)
        cancelNotifications(context)
      }
      eventSink?.invoke("onAnalysisStop", mapOf("message" to message, "runToken" to token.toDouble()))
    }

    fun createChannels(context: Context) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = notificationManager(context)
        manager.createNotificationChannel(NotificationChannel(RUNNING_CHANNEL, "Análise BTC em execução", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(
          NotificationChannel(RESULT_CHANNEL, "Resultados dos ciclos BTC", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Resultados da análise; independente da notificação permanente do serviço."
            setSound(
              RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
              AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
            )
          }
        )
      }
    }

    fun openApp(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      return PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @Synchronized fun notifyCycle(context: Context, title: String, body: String, publicBody: String, token: Long) {
      if (!active || token != runToken) return
      postResultNotification(context, title, body, publicBody)
    }

    @Synchronized fun notifyResult(context: Context, title: String, body: String, publicBody: String) {
      if (!active) return
      postResultNotification(context, title, body, publicBody)
    }

    private fun postResultNotification(context: Context, title: String, body: String, publicBody: String) {
      val publicVersion = NotificationCompat.Builder(context, RESULT_CHANNEL)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("BTC Live Analyzer")
        .setContentText(publicBody)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .build()
      val notification = NotificationCompat.Builder(context, RESULT_CHANNEL)
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(openApp(context))
        .setAutoCancel(true)
        .setDefaults(NotificationCompat.DEFAULT_ALL)
        .setCategory(NotificationCompat.CATEGORY_STATUS)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(publicVersion)
        .build()
      notificationManager(context).notify(RESULT_ID, notification)
    }

    fun cancelNotifications(context: Context) {
      val manager = notificationManager(context)
      manager.cancel(RESULT_ID)
      manager.cancel(RUNNING_ID)
    }

    private fun notificationManager(context: Context): NotificationManager =
      context.getSystemService(NotificationManager::class.java)
        ?: throw IllegalStateException("Gerenciador de notificações Android indisponível.")

    @Synchronized fun requestStop(context: Context, message: String = "Análise interrompida pelo usuário.") {
      active = false
      stopCapture(context)
      // Retain the last snapshot for reopening the UI, but never report a dead
      // service as running. Real history remains in the existing AsyncStorage.
      snapshot?.let {
        val state = JSONObject(it)
        state.put("isRunning", false)
        state.put("marketStatus", "DESATIVADA")
        state.put("error", message)
        snapshot = state.toString()
      }
      eventSink?.invoke("onAnalysisStop", mapOf("message" to message, "runToken" to runToken.toDouble()))
      context.stopService(Intent(context, BtcAnalysisService::class.java))
      cancelNotifications(context)
    }

    private fun stopCapture(context: Context) {
      context.sendBroadcast(Intent("com.btcliveanalyzer.STOP_CAPTURE").setPackage(context.packageName))
    }
  }
}