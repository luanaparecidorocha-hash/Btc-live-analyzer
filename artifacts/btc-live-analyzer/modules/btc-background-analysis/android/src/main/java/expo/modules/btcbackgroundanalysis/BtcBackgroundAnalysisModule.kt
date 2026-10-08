package expo.modules.btcbackgroundanalysis

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class BtcBackgroundAnalysisModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BtcBackgroundAnalysis")
    BtcCrashDiagnostics.record("native.background.module.definition")
    Events("onAnalysisState", "onAnalysisStop")
    OnCreate {
      BtcCrashDiagnostics.record("native.background.module.onCreate")
      BtcAnalysisService.eventSink = { event, payload -> sendEvent(event, payload) }
    }
    Function<Any?, String, String>("recordDiagnostic") { stage: String, detail: String ->
      if (stage == "JS_FATAL" || stage == "REACT_RENDER_ERROR") BtcCrashDiagnostics.failureText(stage, detail)
      else BtcCrashDiagnostics.record(stage, detail)
      null
    }
    Function<Any?>("markStartupReady") {
      BtcCrashDiagnostics.ready()
      null
    }
    AsyncFunction("start") {
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android indisponível.")
      if (appContext.currentActivity == null) throw IllegalStateException("Inicie a análise com o aplicativo aberto.")
      if (!BtcAnalysisService.claimStart()) return@AsyncFunction null
      try {
        val intent = Intent(context, BtcAnalysisService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (error: Exception) {
        BtcAnalysisService.active = false
        Log.e("BtcBackgroundAnalysis", "Falha ao solicitar o início do serviço Android.", error)
        throw error
      }
      null
    }
    AsyncFunction("stop") {
      appContext.reactContext?.let { BtcAnalysisService.requestStop(it) }
      null
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
    AsyncFunction<Any?, String, Double>("publishSnapshot") { json: String, token: Double ->
      BtcAnalysisService.publishSnapshot(json, token.toLong())
      null
    }
    AsyncFunction<Any?, String, String, String, Double>("notifyCycle") { title: String, body: String, publicBody: String, token: Double ->
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android indisponível.")
      if (!BtcAnalysisService.active || token.toLong() != BtcAnalysisService.runToken) return@AsyncFunction null
      requireResultNotificationsEnabled(context)
      BtcAnalysisService.notifyCycle(context, title, body, publicBody, token.toLong())
      null
    }
    AsyncFunction<Any?, String, String, String>("notifyResult") { title: String, body: String, publicBody: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("Contexto Android indisponível.")
      if (!BtcAnalysisService.active) return@AsyncFunction null
      requireResultNotificationsEnabled(context)
      BtcAnalysisService.notifyResult(context, title, body, publicBody)
      null
    }
    OnDestroy { BtcAnalysisService.eventSink = null }
  }

  private fun requireResultNotificationsEnabled(context: Context) {
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
  }
}