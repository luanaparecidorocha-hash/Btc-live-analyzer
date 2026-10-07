// Source-contract guards, not proof of execution on a physical Android device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const capture = read('modules/btc-screen-capture/android/src/main/java/expo/modules/btcscreencapture/ScreenCaptureService.kt');
const permission = read('modules/btc-screen-capture/android/src/main/java/expo/modules/btcscreencapture/BtcScreenCaptureModule.kt');
const service = read('modules/btc-background-analysis/android/src/main/java/expo/modules/btcbackgroundanalysis/BtcAnalysisService.kt');
const context = read('context/AnalyzerContext.tsx');

test('background analysis retains foreground dataSync ownership and unlimited Headless task, not a two-minute timeout', () => {
  assert.match(service, /startForeground\(RUNNING_ID, notification, ServiceInfo\.FOREGROUND_SERVICE_TYPE_DATA_SYNC\)/);
  assert.match(service, /HeadlessJsTaskConfig\("BtcContinuousAnalysis", data, 0L, true\)/);
  assert.match(service, /setOngoing\(true\)/);
  assert.match(service, /Kraken \+ Binance em ciclos de 5 minutos/);
  assert.match(service, /override fun onTimeout/);
  assert.match(service, /super\.onStartCommand\(intent, flags, startId\)/);
});

test('returning to the Activity queries native analysis and capture without starting/stopping or requesting consent', () => {
  const resume = context.slice(context.indexOf('let refreshGeneration'), context.indexOf('useEffect(() => {\n    AsyncStorage'));
  assert.match(resume, /AppState\.addEventListener\('change'/);
  assert.match(resume, /state === 'active'/);
  assert.match(resume, /native!\.isActive\(\)/);
  assert.match(resume, /getBackgroundAnalysisSnapshot\(\)/);
  assert.match(resume, /getScreenCaptureState\(\)/);
  assert.match(resume, /run !== runGeneration\.current/);
  assert.match(resume, /starting\.current/);
  assert.doesNotMatch(resume, /requestScreenCapturePermission|native!\.start|native!\.stop|collection\.start|collection\.stop/);
});

test('capture consent requests the full display on Android 14+, with a single-use token and a native snapshot getter', () => {
  assert.match(permission, /Build\.VERSION\.SDK_INT >= 34/);
  assert.match(permission, /MediaProjectionConfig\.createConfigForDefaultDisplay\(\)/);
  assert.match(permission, /else manager\.createScreenCaptureIntent\(\)/);
  assert.match(permission, /permissionData = null \/\/ Android 14\+ consent tokens are single-use/);
  assert.match(permission, /AsyncFunction\("getState"\)/);
});

test('Android interruption and invisible captured content are reported, without automatically reacquiring permission', () => {
  assert.match(capture, /override fun onStop\(\)[\s\S]*reportInterruption\("O Android interrompeu/);
  assert.match(capture, /onCapturedContentVisibilityChanged/);
  assert.match(capture, /emitState\(if \(isVisible\) "ATIVA" else "ERRO", message\)/);
  assert.match(capture, /notify\(INTERRUPTED_ID, warning\)/);
  assert.match(capture, /if \(wasRunning && !userStopped\)/);
  assert.doesNotMatch(capture, /createScreenCaptureIntent|requestPermission/);
});

test('native notification STOP ends capture independently of the React Activity and JS', () => {
  const stop = service.slice(service.indexOf('@Synchronized fun requestStop'));
  assert.match(stop, /stopCapture\(context\)/);
  assert.match(stop, /context\.stopService/);
  assert.match(stop, /cancelNotifications\(context\)/);
  assert.match(stop, /sendBroadcast\(Intent\("com\.btcliveanalyzer\.STOP_CAPTURE"\)\.setPackage\(context\.packageName\)\)/);
  assert.match(capture, /ContextCompat\.RECEIVER_NOT_EXPORTED/);
  assert.match(capture, /userStopped = true[\s\S]*stopSelf\(\)/);
  assert.match(capture, /unregisterReceiver\(stopReceiver\)/);
});

test('capture scanning is bounded while acquisition still closes each Image and keeps maxImages=2', () => {
  assert.match(capture, /FRAME_INTERVAL_MS = 1000L/);
  assert.match(capture, /now - lastProcessedAt < FRAME_INTERVAL_MS/);
  assert.match(capture, /finally\s*{\s*image\?\.close\(\)/);
  assert.match(capture, /ImageReader\.newInstance\(width, height, PixelFormat\.RGBA_8888, 2\)/);
  assert.match(capture, /if \(readFailures >= 3\)[\s\S]*cleanupProjection\(\)[\s\S]*stopSelf\(\)/);
});
