package expo.modules.btcbackgroundanalysis

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * Installed before React Native loads. No RN/Expo runtime is required to read it.
 * Local only: no READ_LOGS permission, telemetry, SDK or market/capture changes.
 */
object BtcCrashDiagnostics {
  private const val TAG = "BtcDiagnostics"
  private const val LIMIT = 64_000
  private var context: Context? = null
  private var installed = false
  @Volatile private var ownLogcat: java.lang.Process? = null
  @Volatile var needsRecovery = false
    private set
  private val lock = Any()

  private fun folder(ctx: Context) = File(ctx.noBackupFilesDir, "btc-diagnostics").apply { mkdirs() }
  private fun preferences(ctx: Context) = ctx.getSharedPreferences("btc-startup-diagnostics", Context.MODE_PRIVATE)

  fun install(ctx: Context) {
    context = ctx.applicationContext ?: ctx
    if (!installed) {
      installed = true
      safely("install") {
        val prefs = preferences(ctx)
        needsRecovery = prefs.getBoolean("startupPending", false) || prefs.getBoolean("failureRecorded", false)
        collectPreviousExits(ctx)
        record("native.attach", "pid=${Process.myPid()}; recovery=$needsRecovery")
        captureOwnProcessLogcat()
      }
    }
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    if (previous !is DiagnosticExceptionHandler) {
      Thread.setDefaultUncaughtExceptionHandler(DiagnosticExceptionHandler(previous))
    }
  }

  private class DiagnosticExceptionHandler(
    private val previous: Thread.UncaughtExceptionHandler?
  ) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, error: Throwable) {
      try {
        failure("JAVA_UNCAUGHT thread=${thread.name}", error)
      } finally {
        try { ownLogcat?.destroy() } catch (_: Throwable) { /* Always delegate the original fatal error. */ }
        // Preserve Android's fatal handling. Never turn a fatal error into success.
        if (previous != null) previous.uncaughtException(thread, error)
        else {
          Process.killProcess(Process.myPid())
          exitProcess(10)
        }
      }
    }
  }

  fun beginStartup(ctx: Context) {
    needsRecovery = false
    safely("startup marker") {
      check(preferences(ctx).edit()
        .putBoolean("startupPending", true)
        .putBoolean("failureRecorded", false)
        .putLong("acknowledgedExitAt", System.currentTimeMillis())
        .commit()) { "Não foi possível persistir o marcador de inicialização." }
    }
    record("native.bootstrap.begin", "React Native ainda não está pronto.")
  }

  fun ready() {
    val ctx = context ?: return
    safely("ready marker") {
      check(preferences(ctx).edit().putBoolean("startupPending", false).commit()) {
        "Não foi possível persistir o término da inicialização."
      }
    }
    record("js.ui.ready", "Primeira tela montada; fontes carregadas ou erro de fontes tratado.")
  }

  fun resumeExistingRuntime(ctx: Context) {
    needsRecovery = false
    safely("existing-runtime retry") {
      check(preferences(ctx).edit()
        .putBoolean("startupPending", false)
        .putBoolean("failureRecorded", false)
        .putLong("acknowledgedExitAt", System.currentTimeMillis())
        .commit()) { "Não foi possível persistir a tentativa de retorno ao aplicativo." }
    }
    record("native.retry.existing", "Runtime já carregado; relatórios anteriores mantidos.")
  }

  fun failure(kind: String, error: Throwable) {
    val writer = StringWriter()
    error.printStackTrace(PrintWriter(writer))
    failureText(kind, writer.toString())
  }

  fun failureText(kind: String, stack: String) {
    needsRecovery = true
    val ctx = context ?: return
    safely("fatal persistence") {
      synchronized(lock) {
        File(folder(ctx), "last-failure.txt").writeText(
          "time=${System.currentTimeMillis()}\nkind=$kind\npid=${Process.myPid()}\n${stack.take(LIMIT)}\n"
        )
        check(preferences(ctx).edit().putBoolean("failureRecorded", true).commit()) {
          "Não foi possível persistir o indicador de falha."
        }
      }
    }
    record(kind, stack.take(2_000))
  }

  fun record(stage: String, detail: String = "") {
    val ctx = context ?: return
    safely("breadcrumb") {
      synchronized(lock) {
        val file = File(folder(ctx), "timeline.txt")
        if (file.exists() && file.length() > LIMIT * 2) {
          file.writeText(file.readText().takeLast(LIMIT))
        }
        file.appendText("${System.currentTimeMillis()} [$stage] ${detail.take(4_000)}\n")
      }
    }
  }

  private fun collectPreviousExits(ctx: Context) {
    if (Build.VERSION.SDK_INT < 30) return
    val manager = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
    val exits = manager.getHistoricalProcessExitReasons(ctx.packageName, 0, 8)
    val acknowledged = preferences(ctx).getLong("acknowledgedExitAt", 0)
    val text = exits.joinToString("\n") {
      "time=${it.timestamp}; pid=${it.pid}; reason=${it.reason}; status=${it.status}; description=${it.description}"
    }
    File(folder(ctx), "android-exits.txt").writeText(text.take(LIMIT))
    val crash = exits.firstOrNull {
      it.pid != Process.myPid() && it.timestamp > acknowledged && it.reason in setOf(
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE
      )
    } ?: return
    needsRecovery = true
    // Native traces may be protobuf, not text. Preserve their original bytes.
    Thread({
      safely("previous exit trace") {
        crash.traceInputStream?.use { input ->
          val destination = File(folder(ctx), "android-exit.trace")
          val temporary = File(folder(ctx), "android-exit.trace.pending")
          temporary.outputStream().use { output ->
            val buffer = ByteArray(8192)
            var total = 0
            while (total < 2_000_000) {
              val count = input.read(buffer, 0, minOf(buffer.size, 2_000_000 - total))
              if (count < 0) break
              output.write(buffer, 0, count)
              total += count
            }
            if (total == 2_000_000) record("trace.limit", "Rastreamento limitado a 2 MB; pode estar incompleto.")
          }
          check(temporary.renameTo(destination)) { "Não foi possível publicar o trace Android." }
          record("android.exit.trace", "reason=${crash.reason}; file=${destination.name}")
        }
      }
    }, "btc-previous-exit").apply { isDaemon = true; start() }
  }

  private fun captureOwnProcessLogcat() {
    Thread({
      safely("own-process logcat") {
        // This reader dies with THIS process. Previous-process evidence uses
        // persisted files/ApplicationExitInfo, not a PID filter across restarts.
        val reader = ProcessBuilder(
          "logcat", "-b", "main", "-b", "crash", "-v", "threadtime",
          "--pid=${Process.myPid()}", "AndroidRuntime:V", "ReactNativeJS:V",
          "ReactNative:V", "ReactNativeJNI:V", "ExpoModulesCore:V",
          "BtcAnalysisService:V", "BtcBackgroundAnalysis:V", "libc:F", "*:S"
        ).redirectErrorStream(true).start()
        ownLogcat = reader
        Thread({
          Thread.sleep(120_000)
          reader.destroy()
          record("logcat.window.end", "Janela de logs de inicialização encerrada; handler Java permanece ativo.")
        }, "btc-logcat-timeout").apply { isDaemon = true; start() }
        try {
          reader.inputStream.bufferedReader().useLines { lines ->
            lines.forEach { record("logcat.ownPid", it) }
          }
          val status = reader.waitFor()
          if (status != 0) record("logcat.unavailable", "exit=$status; stack e exit-info continuam independentes.")
        } finally {
          reader.destroy()
          ownLogcat = null
        }
      }
    }, "btc-own-logcat").apply { isDaemon = true; start() }
  }

  fun traceFile(ctx: Context): File? = File(folder(ctx), "android-exit.trace").takeIf { it.exists() && it.length() > 0 }

  fun report(ctx: Context): String {
    val output = StringBuilder()
    output.append("BTC LIVE ANALYZER — DIAGNÓSTICO LOCAL\n")
    output.append("Captura não comprova causa até examinar a stack. Sem dados enviados automaticamente.\n")
    output.append("package=${ctx.packageName}\nmodel=${Build.MANUFACTURER} ${Build.MODEL}\n")
    output.append("android=${Build.VERSION.RELEASE}; sdk=${Build.VERSION.SDK_INT}; build=${Build.DISPLAY}\n")
    try {
      val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      val versionCode = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
      output.append("appVersion=${info.versionName}; versionCode=$versionCode; apkUpdatedAt=${info.lastUpdateTime}\n")
    } catch (error: Exception) {
      output.append("appVersion=(indisponível: ${error.javaClass.simpleName})\n")
    }
    output.append("collector=in-app-startup-diagnostics; time=${System.currentTimeMillis()}\n")
    output.append("Native SIGSEGV/SIGABRT não são interceptados pelo handler Java.\n")
    output.append("Registros Android de processos anteriores podem pertencer ao APK anterior; confira timestamps.\n")
    for (name in listOf("last-failure.txt", "android-exits.txt", "timeline.txt")) {
      output.append("\n===== $name =====\n")
      val file = File(folder(ctx), name)
      synchronized(lock) {
        output.append(try {
          if (file.exists()) file.readText().takeLast(LIMIT) else "(sem registro)"
        } catch (error: Exception) {
          "(falha de leitura: ${error.javaClass.simpleName})"
        })
      }
      output.append("\n")
    }
    traceFile(ctx)?.let { output.append("\nTrace Android disponível separadamente: ${it.name}; ${it.length()} bytes.\n") }
    return output.toString().take(200_000)
  }

  private fun safely(operation: String, work: () -> Unit) {
    try {
      work()
    } catch (error: Throwable) {
      // Diagnostics must never cause a second app crash or mask the original.
      Log.e(TAG, "Diagnóstico indisponível: $operation", error)
    }
  }
}
