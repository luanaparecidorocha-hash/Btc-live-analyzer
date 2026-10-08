import { Platform } from 'react-native';
import type { Signal } from './analysis';
import { cycleNotificationContent, requestNotificationPermission, RESULT_NOTIFICATION_CHANNEL } from './notificationPolicy';
import type { DurationRecommendation } from './signalLearning';
import { nativeBackgroundAnalysis } from './backgroundAnalysis';

export async function prepareNotifications(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const Notifications = await import('expo-notifications');
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(RESULT_NOTIFICATION_CHANNEL, {
        name: 'Resultados dos ciclos BTC',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: 'default',
      });
    }
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    return requestNotificationPermission({
      getPermissions: Notifications.getPermissionsAsync,
      requestPermissions: Notifications.requestPermissionsAsync,
    });
  } catch {
    return false;
  }
}

export async function notifySignal(signal: Signal, confidence: number, trend?: 'ALTA' | 'BAIXA' | 'LATERAL', recommendation: DurationRecommendation = null): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const content = cycleNotificationContent(signal, trend ?? 'não informada', confidence, recommendation);
    if (Platform.OS === 'android') {
      if (!nativeBackgroundAnalysis) {
        throw new Error('O módulo nativo de notificações Android não está disponível.');
      }
      await nativeBackgroundAnalysis.notifyResult(content.title, content.body, content.publicBody);
      return;
    }

    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: content.title,
        body: content.body,
        sound: 'default',
      },
      trigger: null,
    });
  } catch {
    // Never stop collection, but let the caller report a delivery failure.
    throw new Error('Não foi possível exibir a notificação do resultado.');
  }
}