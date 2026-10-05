package __APP_PACKAGE__

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics

/** Native launcher/recovery UI; it does not require React, Hermes or Expo UI. */
class BtcDiagnosticActivity : Activity() {
  private val saveText = 4101
  private val saveTrace = 4102

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (!BtcCrashDiagnostics.needsRecovery && !intent.getBooleanExtra("btcDiagnosticScreen", false)) {
      forwardToApp()
      return
    }
    showReport()
  }

  private fun forwardToApp() {
    BtcCrashDiagnostics.record("native.launcher.forward", "Abrindo MainActivity.")
    startActivity(Intent(intent).setClassName(packageName, "$packageName.MainActivity"))
    finish()
  }

  private fun showReport() {
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(24, 36, 24, 24)
      fitsSystemWindows = true
    }
    layout.addView(TextView(this).apply {
      text = "Diagnóstico do BTC Live Analyzer"
      textSize = 22f
      setTypeface(typeface, Typeface.BOLD)
    })
    layout.addView(TextView(this).apply {
      text = "Há uma falha registrada ou a inicialização anterior não terminou. Isso não identifica, por si só, a causa. Salve o relatório antes de tentar novamente. Ele contém dados do aparelho e logs do app; revise antes de compartilhar."
      setPadding(0, 12, 0, 12)
    })
    addButton(layout, "Salvar relatório .txt") {
      createDocument(saveText, "text/plain", "btc-diagnostico-${System.currentTimeMillis()}.txt")
    }
    addButton(layout, "Compartilhar texto") {
      startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, BtcCrashDiagnostics.report(this@BtcDiagnosticActivity))
      }, "Compartilhar diagnóstico"))
    }
    addButton(layout, "Salvar trace do Android, se disponível") {
      if (BtcCrashDiagnostics.traceFile(this) == null) {
        Toast.makeText(this, "O Android ainda não forneceu um trace. O relatório de texto continua disponível.", Toast.LENGTH_LONG).show()
      } else createDocument(saveTrace, "application/octet-stream", "btc-android-exit.trace")
    }
    addButton(layout, "Tentar abrir o aplicativo") {
      try {
        // The plugin adds this method to the generated MainApplication.
        application.javaClass.getMethod("initializeReactForDiagnostics").invoke(application)
        forwardToApp()
      } catch (error: Throwable) {
        BtcCrashDiagnostics.failure("NATIVE_RETRY_FAILURE", error.cause ?: error)
        Toast.makeText(this, "Falha registrada. Salve o relatório.", Toast.LENGTH_LONG).show()
        showReport()
      }
    }
    val report = TextView(this).apply {
      text = BtcCrashDiagnostics.report(this@BtcDiagnosticActivity)
      textSize = 12f
      typeface = Typeface.MONOSPACE
      setTextIsSelectable(true)
    }
    layout.addView(ScrollView(this).apply { addView(report) },
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    setContentView(layout)
  }

  private fun addButton(layout: LinearLayout, text: String, action: () -> Unit) {
    layout.addView(Button(this).apply {
      this.text = text
      setOnClickListener {
        try { action() } catch (error: Exception) {
          BtcCrashDiagnostics.record("diagnostic.export.error", error.toString())
          Toast.makeText(this@BtcDiagnosticActivity, "Não foi possível abrir o compartilhamento/salvamento.", Toast.LENGTH_LONG).show()
        }
      }
    })
  }

  private fun createDocument(request: Int, mime: String, name: String) {
    startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mime
      putExtra(Intent.EXTRA_TITLE, name)
    }, request)
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode != RESULT_OK || requestCode !in listOf(saveText, saveTrace)) return
    val uri = data?.data ?: return
    try {
      val output = contentResolver.openOutputStream(uri) ?: throw IllegalStateException("Arquivo indisponível.")
      output.use {
        if (requestCode == saveText) {
          it.write(BtcCrashDiagnostics.report(this).toByteArray(Charsets.UTF_8))
        } else {
          val trace = BtcCrashDiagnostics.traceFile(this) ?: throw IllegalStateException("Trace indisponível.")
          trace.inputStream().use { input -> input.copyTo(it) }
        }
      }
      Toast.makeText(this, "Diagnóstico salvo.", Toast.LENGTH_LONG).show()
    } catch (error: Exception) {
      BtcCrashDiagnostics.record("diagnostic.save.error", error.toString())
      Toast.makeText(this, "Falha ao salvar. Tente Compartilhar texto.", Toast.LENGTH_LONG).show()
    }
  }
}
