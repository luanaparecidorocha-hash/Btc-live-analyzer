import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { instrumentApplication, instrumentManifest } = require('../plugins/with-startup-diagnostics.cjs');
const ts = require('typescript');
const source = fs.readFileSync(new URL('../lib/startupDiagnostics.ts', import.meta.url), 'utf8');

function bootstrap(platform = 'android', nativeThrows = false) {
  const records = [];
  const delegated = [];
  let handler;
  let ready = 0;
  const context = {
    exports: {},
    console,
    ErrorUtils: {
      getGlobalHandler: () => (error, fatal) => delegated.push([error, fatal]),
      setGlobalHandler: (callback) => { handler = callback; },
    },
    require: (name) => {
      if (name === 'react-native') return { Platform: { OS: platform } };
      if (name === 'expo') {
        if (nativeThrows) throw new Error('simulated native import failure');
        return { requireOptionalNativeModule: () => ({
          recordDiagnostic: (stage, detail) => records.push([stage, detail]),
          markStartupReady: () => { ready++; },
        }) };
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const run = () => vm.runInNewContext(output, context);
  return { context, run, records, delegated, getHandler: () => handler, getReady: () => ready };
}

test('JS fatal stack persists before delegating to the existing fatal handler', () => {
  const state = bootstrap();
  state.run();
  const error = new Error('simulated startup error');
  state.getHandler()(error, true);
  assert.ok(state.records.some(([stage, detail]) => stage === 'JS_FATAL' && detail.includes('simulated startup error')));
  assert.deepEqual(state.delegated, [[error, true]]);
  state.context.exports.markStartupReady();
  assert.equal(state.getReady(), 1);
});

test('web does not require an Android native diagnostic module', () => {
  const state = bootstrap('web');
  state.run();
  state.context.exports.markStartupReady();
  assert.equal(state.records.length, 0);
  assert.equal(state.getReady(), 0);
});

test('the global handler is installed before a native import failure, which is not hidden', () => {
  const state = bootstrap('android', true);
  assert.throws(state.run, /simulated native import failure/);
  assert.equal(typeof state.getHandler(), 'function');
});

test('native application instrumentation is early, idempotent and preserves bootstrap', () => {
  const input = `class MainApplication {
    override fun onCreate() {
      super.onCreate()
      DefaultNewArchitectureEntryPoint.releaseLevel = try { ReleaseLevel.STABLE } catch (e: Exception) { ReleaseLevel.STABLE }
      loadReactNative(this)
      ApplicationLifecycleDispatcher.onApplicationCreate(this)
    }
    override fun onConfigurationChanged(newConfig: Configuration) {
      ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
    }
  }`;
  const output = instrumentApplication(input);
  assert.ok(output.includes('override fun attachBaseContext'));
  assert.ok(output.includes('BtcCrashDiagnostics.install(this)'));
  assert.ok(output.includes('BtcCrashDiagnostics.needsRecovery'));
  assert.ok(output.includes('fun initializeReactForDiagnostics()'));
  assert.equal(output.match(/loadReactNative\(this\)/g).length, 1);
  assert.ok(output.includes('if (diagnosticReactInitialized) ApplicationLifecycleDispatcher.onConfigurationChanged'));
  assert.equal(instrumentApplication(output), output);
  assert.throws(() => instrumentApplication('class Unexpected {}'), /onCreate/);
});

test('launcher and deep links pass through native recovery, with no duplicate launcher', () => {
  const filters = [
    { action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }] },
    { action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] },
  ];
  const manifest = { application: [{ activity: [{ $: { 'android:name': '.MainActivity' }, 'intent-filter': filters }] }] };
  instrumentManifest(manifest);
  const activities = manifest.application[0].activity;
  assert.deepEqual(activities[0]['intent-filter'], []);
  assert.deepEqual(activities[1]['intent-filter'], filters);
  assert.equal(activities[1].$['android:name'], '.BtcDiagnosticActivity');
  assert.equal(activities[1].$['android:screenOrientation'], 'portrait');
  instrumentManifest(manifest);
  assert.equal(activities.length, 2);
});
