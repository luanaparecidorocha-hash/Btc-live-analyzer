const fs = require('node:fs/promises');
const path = require('node:path');
const { withMainApplication, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

function instrumentApplication(contents) {
  if (contents.includes('// BTC_STARTUP_DIAGNOSTICS')) return contents;
  const signature = 'override fun onCreate() {';
  const start = contents.indexOf(signature);
  if (start < 0) throw new Error('Diagnóstico: MainApplication Kotlin sem onCreate reconhecível.');
  const opening = contents.indexOf('{', start);
  let depth = 1;
  let end = opening + 1;
  for (; end < contents.length && depth; end++) {
    if (contents[end] === '{') depth++;
    if (contents[end] === '}') depth--;
  }
  if (depth) throw new Error('Diagnóstico: bloco onCreate incompleto.');
  const original = contents.slice(opening + 1, end - 1);
  if (!original.includes('super.onCreate()') || !original.includes('loadReactNative(this)')) {
    throw new Error('Diagnóstico: bootstrap Expo mudou; não modificar silenciosamente.');
  }
  const bootstrap = original.replace('super.onCreate()', '');
  const replacement = `// BTC_STARTUP_DIAGNOSTICS
  private var diagnosticReactInitialized = false

  override fun attachBaseContext(base: android.content.Context) {
    super.attachBaseContext(base)
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.install(this)
  }

  override fun onCreate() {
    super.onCreate()
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.record("native.application.onCreate")
    if (!expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.needsRecovery) {
      initializeReactForDiagnostics()
    }
  }

  @Synchronized
  fun initializeReactForDiagnostics() {
    if (diagnosticReactInitialized) {
      expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.resumeExistingRuntime(this)
      return
    }
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.beginStartup(this)
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.record("native.react.load.begin")
    ${bootstrap}
    diagnosticReactInitialized = true
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.install(this)
    expo.modules.btcbackgroundanalysis.BtcCrashDiagnostics.record("native.react.load.returned")
  }`;
  const instrumented = contents.slice(0, start) + replacement + contents.slice(end);
  return instrumented.replace(
    'ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)',
    'if (diagnosticReactInitialized) ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)'
  );
}

function instrumentManifest(manifest) {
  const app = manifest.application?.[0];
  const main = app?.activity?.find(a => a.$['android:name'] === '.MainActivity' || a.$['android:name'].endsWith('.MainActivity'));
  if (!main) throw new Error('Diagnóstico: MainActivity ausente no manifesto.');
  const name = '.BtcDiagnosticActivity';
  if (app.activity.some(a => a.$['android:name'] === name)) return manifest;
  const filters = main['intent-filter'] || [];
  if (!filters.some(f => f.action?.some(a => a.$['android:name'] === 'android.intent.action.MAIN'))) {
    throw new Error('Diagnóstico: filtro launcher ausente.');
  }
  // Forward launcher AND deep links through a native gate, before React UI.
  main['intent-filter'] = [];
  app.activity.push({
    $: {
      'android:name': name,
      'android:exported': 'true',
      'android:screenOrientation': 'portrait',
      'android:theme': '@android:style/Theme.Material.Light.NoActionBar',
    },
    'intent-filter': filters,
  });
  return manifest;
}

function plugin(config) {
  config = withMainApplication(config, c => {
    if (c.modResults.language !== 'kt') throw new Error('Diagnóstico requer MainApplication Kotlin.');
    c.modResults.contents = instrumentApplication(c.modResults.contents);
    return c;
  });
  config = withAndroidManifest(config, c => {
    c.modResults.manifest = instrumentManifest(c.modResults.manifest);
    return c;
  });
  return withDangerousMod(config, ['android', async c => {
    const pkg = c.android?.package;
    if (!pkg || !/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)+$/.test(pkg)) throw new Error('Diagnóstico: package Android inválido.');
    const file = path.join(c.modRequest.projectRoot, 'native-diagnostics', 'BtcDiagnosticActivity.kt');
    const source = (await fs.readFile(file, 'utf8')).replace('__APP_PACKAGE__', pkg);
    const destination = path.join(c.modRequest.platformProjectRoot, 'app/src/main/java', ...pkg.split('.'));
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'BtcDiagnosticActivity.kt'), source);
    return c;
  }]);
}

module.exports = plugin;
module.exports.instrumentApplication = instrumentApplication;
module.exports.instrumentManifest = instrumentManifest;
