// Source-level regression guards, NOT an Android device/MediaProjection test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL(
  '../modules/btc-screen-capture/android/src/main/java/expo/modules/btcscreencapture/ScreenCaptureService.kt',
  import.meta.url,
), 'utf8');
const consume = source.slice(source.indexOf('private fun consumeLatestImage('), source.indexOf('private fun processImage('));
const process = source.slice(source.indexOf('private fun processImage('), source.indexOf('private fun createNotificationChannel('));
const cleanup = source.slice(source.indexOf('private fun cleanupProjection('), source.indexOf('override fun onTaskRemoved('));
const destroy = source.slice(source.indexOf('override fun onDestroy('), source.indexOf('override fun onBind('));

test('capture retains maxImages=2 and a dedicated serial listener, not an async queue of open Images', () => {
  assert.match(source, /ImageReader\.newInstance\(width, height, PixelFormat\.RGBA_8888, 2\)/);
  assert.match(source, /HandlerThread\("BtcScreenCapture"\)/);
  assert.match(source, /consumeLatestImage\(availableReader, width, height, region\)\s*}, handler\)/);
  assert.doesNotMatch(source, /ExecutorService|Executors|executor|acquireNextImage/);
  assert.equal((source.match(/acquireLatestImage\(\)/g) ?? []).length, 1);
});

test('the only acquisition is inside the shutdown lock and its finally closes even null/failed frames', () => {
  assert.match(consume, /synchronized\(captureLock\)/);
  assert.match(consume, /if \(!started \|\| cleaningUp \|\| reader !== imageReader\) return/);
  assert.match(consume, /try\s*{\s*image = reader\.acquireLatestImage\(\) \?: return\s*processImage\(image, width, height, region\)/);
  assert.match(consume, /finally\s*{\s*image\?\.close\(\)/);
  assert.ok(consume.indexOf('finally') < consume.indexOf('eventSink?.invoke'));
  assert.doesNotMatch(consume, /execute\s*{|launch\s*{|async\s*{|await/);
});

test('image planes and buffer remain local: only fully computed scalar values leave processing', () => {
  assert.match(process, /: Map<String, Any>\?/);
  assert.doesNotMatch(process, /eventSink|Handler|execute|async|await/);
  assert.match(process, /val buffer: ByteBuffer = plane\.buffer/);
  assert.match(process, /if \(candidatePixels < MIN_CANDIDATE_PIXELS \|\| sampledPixels == 0\) return null/);
  const frame = process.slice(process.indexOf('return mapOf('));
  assert.doesNotMatch(frame, /\bimage\b|\bplane\b|\bbuffer\b/);
  for (const key of ['timestamp', 'position', 'meanLuma', 'candidatePixels']) {
    assert.ok(frame.includes(`"${key}"`));
  }
});

test('shutdown invalidates stale callbacks and independently attempts all native resource releases', () => {
  assert.match(cleanup, /synchronized\(captureLock\)/);
  assert.match(cleanup, /if \(cleaningUp\) return/);
  assert.ok(cleanup.indexOf('imageReader = null') < cleanup.indexOf('activeReader?.close()'));
  assert.ok(cleanup.indexOf('setOnImageAvailableListener(null, null)') < cleanup.indexOf('activeReader?.close()'));
  for (const call of ['activeDisplay?.release()', 'activeReader?.close()', 'activeProjection.unregisterCallback(activeCallback)', 'activeProjection?.stop()']) {
    assert.ok(cleanup.includes(call), call);
  }
  assert.match(cleanup, /private fun releaseCaptureResource[\s\S]*catch \(error: Exception\)/);
  assert.match(source, /if \(cleaningUp \|\| projection !== activeProjection\) return/);
});

test('destruction releases projection before stopping callbacks/thread and preserves background capture', () => {
  assert.ok(destroy.indexOf('cleanupProjection()') < destroy.indexOf('removeCallbacksAndMessages(null)'));
  assert.match(destroy, /captureThread\?\.quitSafely\(\)/);
  assert.match(source, /FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION/);
  assert.match(source, /override fun onTaskRemoved[\s\S]*super\.onTaskRemoved\(rootIntent\)/);
});
