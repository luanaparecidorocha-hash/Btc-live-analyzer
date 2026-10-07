package expo.modules.btcscreencapture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.media.projection.MediaProjectionConfig
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BtcScreenCaptureModule : Module() {
  private var permissionPromise: Promise? = null
  private var permissionData: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("BtcScreenCapture")
    Events("onCaptureStateChanged", "onFrame")

    OnCreate {
      ScreenCaptureService.eventSink = { eventName, payload ->
        sendEvent(eventName, payload)
      }
      ScreenCaptureService.currentState?.let { state ->
        sendEvent("onCaptureStateChanged", state)
      }
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("E_NO_ACTIVITY", "A atividade Android não está disponível.", null)

      if (permissionPromise != null) {
        return@AsyncFunction promise.reject("E_PERMISSION_PENDING", "Já existe uma solicitação de captura em andamento.", null)
      }

      val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      permissionPromise = promise
      sendEvent("onCaptureStateChanged", mapOf("status" to "SOLICITANDO PERMISSÃO"))
      // Capture the display rather than only this Activity, which becomes
      // invisible when the user switches to another app (Android 14+).
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
      } else manager.createScreenCaptureIntent()
      activity.startActivityForResult(intent, REQUEST_CODE)
    }

    AsyncFunction("start") { region: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("O contexto Android não está disponível.")
      val data = permissionData
        ?: throw IllegalStateException("A autorização MediaProjection ainda não foi concedida.")
      permissionData = null // Android 14+ consent tokens are single-use.

      val intent = Intent(context, ScreenCaptureService::class.java).apply {
        putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, Activity.RESULT_OK)
        putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, data)
        putExtra(ScreenCaptureService.EXTRA_REGION_LEFT, (region["left"] as? Number)?.toFloat() ?: 8f)
        putExtra(ScreenCaptureService.EXTRA_REGION_TOP, (region["top"] as? Number)?.toFloat() ?: 24f)
        putExtra(ScreenCaptureService.EXTRA_REGION_WIDTH, (region["width"] as? Number)?.toFloat() ?: 84f)
        putExtra(ScreenCaptureService.EXTRA_REGION_HEIGHT, (region["height"] as? Number)?.toFloat() ?: 48f)
      }

      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      null
    }

    AsyncFunction("stop") {
      val context = appContext.reactContext ?: return@AsyncFunction null
      ScreenCaptureService.requestStop(context)
      null
    }

    AsyncFunction("getState") {
      ScreenCaptureService.currentState ?: mapOf("status" to "DESATIVADA")
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult

      val promise = permissionPromise
      permissionPromise = null
      permissionData = null
      if (payload.resultCode == Activity.RESULT_OK && payload.data != null) {
        permissionData = payload.data
        promise?.resolve(mapOf(
          "granted" to true,
          "supported" to true,
          "status" to "DESATIVADA"
        ))
      } else {
        promise?.resolve(mapOf(
          "granted" to false,
          "supported" to true,
          "status" to "DESATIVADA",
          "message" to "A autorização de captura foi recusada."
        ))
        sendEvent("onCaptureStateChanged", mapOf(
          "status" to "DESATIVADA",
          "message" to "A autorização de captura foi recusada."
        ))
      }
    }

    OnDestroy {
      ScreenCaptureService.eventSink = null
    }
  }

  companion object {
    private const val REQUEST_CODE = 4817
  }
}