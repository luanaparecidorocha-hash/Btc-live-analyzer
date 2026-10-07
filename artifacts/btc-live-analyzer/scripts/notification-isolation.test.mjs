import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RESULT_NOTIFICATION_CHANNEL } from '../lib/notificationPolicy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const service = read('modules/btc-background-analysis/android/src/main/java/expo/modules/btcbackgroundanalysis/BtcAnalysisService.kt');
const notifications = read('lib/notifications.ts');
function sources(dir) {
  return readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (['node_modules', 'build', '.gradle'].includes(entry.name)) return [];
    return entry.isDirectory() ? sources(path) : /\.(kt|xml|tsx?|cjs)$/.test(path) ? [read(path)] : [];
  });
}

test('app code/permissions have no global DND, notification access, volume or audio-focus control', () => {
  const code = [...sources('modules'), ...sources('plugins'), ...sources('lib'), ...sources('android/app/src'), read('app.json')].join('\n');
  assert.doesNotMatch(code, /ACCESS_NOTIFICATION_POLICY|setInterruptionFilter|setNotificationPolicy|requestAudioFocus|setStreamMute|adjustStreamVolume|setStreamVolume|NotificationListenerService|ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS/);
});

test('results use a different channel and ID from ongoing service, with normal sound and immediate channel delivery', () => {
  assert.match(service, new RegExp(`RESULT_CHANNEL = "${RESULT_NOTIFICATION_CHANNEL}"`));
  assert.match(service, /RUNNING_CHANNEL = "btc-analysis-running"/);
  assert.match(service, /RUNNING_ID = 8721/);
  assert.match(service, /RESULT_ID = 8722/);
  assert.match(service, /IMPORTANCE_LOW/);
  assert.match(service, /IMPORTANCE_DEFAULT/);
  assert.match(service, /RingtoneManager\.TYPE_NOTIFICATION/);
  assert.match(service, /setDefaults\(NotificationCompat\.DEFAULT_ALL\)/);
  assert.match(notifications, /shouldPlaySound: true/);
  assert.match(notifications, /sound: 'default'/);
  assert.match(notifications, /trigger: Platform\.OS === 'android' \? \{ channelId: RESULT_NOTIFICATION_CHANNEL \} : null/);
  assert.doesNotMatch(service, /setBypassDnd|cancelAll\(/);
});
