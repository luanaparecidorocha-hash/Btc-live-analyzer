import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cycleNotificationContent, RESULT_NOTIFICATION_CHANNEL } from '../lib/notificationPolicy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const service = read('modules/btc-background-analysis/android/src/main/java/expo/modules/btcbackgroundanalysis/BtcAnalysisService.kt');
const backgroundModule = read('modules/btc-background-analysis/android/src/main/java/expo/modules/btcbackgroundanalysis/BtcBackgroundAnalysisModule.kt');
const notifications = read('lib/notifications.ts');
const backgroundHelper = read('lib/backgroundAnalysis.ts');
const backgroundTask = read('lib/registerBackgroundTask.ts');
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
  assert.match(notifications, /trigger: null/);
  assert.doesNotMatch(service, /setBypassDnd|cancelAll\(/);
});

test('COMPRA, VENDA and AGUARDAR expose the requested public summary without replacing full content', () => {
  const cases = [
    ['POSSÍVEL COMPRA', 'ALTA', 93, 'POSSÍVEL COMPRA • ALTA • 93%'],
    ['POSSÍVEL VENDA', 'BAIXA', 84, 'POSSÍVEL VENDA • BAIXA • 84%'],
    ['AGUARDAR', 'LATERAL', 60, 'AGUARDAR • LATERAL • 60%'],
  ];
  for (const [signal, trend, confidence, publicBody] of cases) {
    const content = cycleNotificationContent(signal, trend, confidence);
    assert.equal(content.title, `Análise de 5 minutos concluída · ${signal}`);
    assert.equal(content.publicBody, publicBody);
    assert.match(content.body, new RegExp(`Tendência: ${trend} · Confirmação: ${confidence}%`));
    assert.match(content.body, /não executa ordens/);
  }
  assert.equal(
    cycleNotificationContent('AGUARDAR', 'não informada', 50).publicBody,
    'AGUARDAR • TENDÊNCIA NÃO INFORMADA • 50%',
  );
});

test('result notification builds an official Android publicVersion on the existing result channel', () => {
  assert.match(service, /NotificationCompat\.Builder\(context, RESULT_CHANNEL\)/);
  assert.match(service, /\.setContentTitle\("BTC Live Analyzer"\)/);
  assert.match(service, /\.setContentText\(publicBody\)/);
  assert.match(service, /\.setVisibility\(NotificationCompat\.VISIBILITY_PUBLIC\)/);
  assert.match(service, /\.setPublicVersion\(publicVersion\)/);
  assert.match(service, /\.setVisibility\(NotificationCompat\.VISIBILITY_PRIVATE\)/);
  assert.match(backgroundModule, /AsyncFunction<Any\?, String, String, String>\("notifyResult"\)/);
  assert.match(notifications, /nativeBackgroundAnalysis\.notifyResult\(content\.title, content\.body, content\.publicBody\)/);
  assert.match(backgroundTask, /notifyCycle\(content\.title, content\.body, content\.publicBody, runToken\)/);
  assert.match(backgroundHelper, /notifyResult: \(title: string, body: string, publicBody: string\)/);
  for (const secretPattern of [/api.?key/i, /secret/i, /password/i, /private.?key/i, /token/i]) {
    assert.doesNotMatch(cycleNotificationContent('POSSÍVEL COMPRA', 'ALTA', 93).publicBody, secretPattern);
  }
});

test('Foreground Service keeps its required ongoing notification independent of result privacy', () => {
  const start = service.indexOf('val notification = NotificationCompat.Builder(this, RUNNING_CHANNEL)');
  const end = service.indexOf('if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)', start);
  const foregroundNotification = service.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(foregroundNotification, /\.setOngoing\(true\)/);
  assert.match(service, /startForeground\(RUNNING_ID, notification/);
  assert.match(service, /RUNNING_ID = 8721/);
  assert.match(service, /RESULT_ID = 8722/);
  assert.doesNotMatch(foregroundNotification, /setPublicVersion/);
});
