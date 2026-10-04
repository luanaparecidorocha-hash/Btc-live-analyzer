package expo.modules.btcbackgroundanalysis

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class BtcBackgroundAnalysisModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BtcBackgroundAnalysis")
    Events("onAnalysisState", "onAnalysisStop")
    OnCreate {
      BtcAnalysisService.eventSink = { event, payload -> sendEvent(event, payload) }
    }
    AsyncFunction("start") {
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android indisponível.")
      if (appContext.currentActivity == null) throw IllegalStateException("Inicie a análise com o aplicativo aberto.")
      if (!BtcAnalysisService.claimStart()) return@AsyncFunction
      try {
        val intent = Intent(context, BtcAnalysisService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: Exception) {
        BtcAnalysisService.active = false
        throw error
      }
    }
    AsyncFunction("stop") {
      appContext.reactContext?.let { BtcAnalysisService.requestStop(it) }
    }
    AsyncFunction("isActive") { BtcAnalysisService.active }
    AsyncFunction("getSnapshot") {
      BtcAnalysisService.snapshot?.let {
        val state = JSONObject(it)
        if (!BtcAnalysisService.active) {
          state.put("isRunning", false)
          state.put("marketStatus", "DESATIVADA")
        }
        state.toString()
      }
    }
    AsyncFunction("publishSnapshot") { json: String, token: Double ->
      BtcAnalysisService.publishSnapshot(json, token.toLong())
    }
    AsyncFunction("notifyCycle") { title: String, body: String, token: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android indisponível.")
      if (!BtcAnalysisService.active || token.toLong() != BtcAnalysisService.runToken) return@AsyncFunction
      if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        throw IllegalStateException("Permissão de notificações não concedida.")
      }
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) throw IllegalStateException("Notificações desativadas nas configurações Android.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager?.getNotificationChannel(BtcAnalysisService.RESULT_CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) {
          throw IllegalStateException("Canal dos resultados BTC desativado nas configurações Android.")
        }
      }
      BtcAnalysisService.notifyCycle(context, title, body, token.toLong())
    }
    OnDestroy { BtcAnalysisService.eventSink = null }
  }
}