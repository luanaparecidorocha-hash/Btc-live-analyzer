import { AppRegistry, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from './analysis';
import { createContinuousCollection } from './continuousCollection';
import { createAnalysisHistoryStore } from './analysisHistory';
import { connectBtcUsdTicker } from './marketData';
import { createAnalysisSession } from './analysisSession';
import { nativeBackgroundAnalysis } from './backgroundAnalysis';
import { stopScreenCapture } from './screenCapture';
import { cycleNotificationContent } from './notificationPolicy';

let currentTask: Promise<void> | null = null;
let taskStopping = false;
const androidHistoryStore = createAnalysisHistoryStore(AsyncStorage);

async function runBackgroundAnalysis(runToken: number) {
  const native = nativeBackgroundAnalysis;
  if (!native) throw new Error('Serviço Android ausente. Use um APK nativo.');
  let stopped = false;
  let stopMessage: string | null = null;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const session = createAnalysisSession({
    windowMs: DEFAULT_ANALYSIS_WINDOW_MS,
    analyze: analyzeChart,
    createCollection: createContinuousCollection,
    connect: connectBtcUsdTicker,
    store: androidHistoryStore,
    notify: (record) => {
      const content = cycleNotificationContent(record.signal, record.direction, record.confidence);
      return native.notifyCycle(content.title, content.body, runToken);
    },
    publish: (state) => {
      const snapshot = stopMessage ? { ...state, error: stopMessage } : state;
      void native.publishSnapshot(JSON.stringify(snapshot), runToken).catch(() => undefined);
    },
  });
  function finish(message?: string) {
    if (stopped) return;
    stopped = true;
    taskStopping = true;
    if (message && message !== 'Análise interrompida pelo usuário.' && message !== 'Serviço Android interrompido.') {
      stopMessage = message;
    }
    session.stop();
    // Finish writes for already-completed cycles, but never notify after stop.
    void Promise.all([session.flush(), stopScreenCapture().catch(() => undefined)])
      .finally(resolveFinished);
  }
  const stopSubscription = native.addListener('onAnalysisStop', (payload) => {
    if (payload.runToken === runToken) finish(payload.message);
  });
  try {
    if (!await native.isActive() || stopped) return;
    await session.start();
    if (stopped) return;
    await finished; // zero native timeout: task stays alive until STOP/OS limit.
  } catch (error) {
    finish(error instanceof Error ? error.message : 'Falha no serviço Android.');
    await native.stop();
    await finished;
  } finally {
    stopSubscription.remove();
    session.stop();
  }
}

if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask('BtcContinuousAnalysis', () => async (data: { runToken: number }) => {
    if (currentTask && taskStopping) await currentTask;
    if (!currentTask) {
      taskStopping = false;
      currentTask = runBackgroundAnalysis(data.runToken).finally(() => { currentTask = null; taskStopping = false; });
    }
    return currentTask;
  });
}