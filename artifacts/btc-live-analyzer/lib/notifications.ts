import { Platform } from 'react-native';
import type { Signal } from './analysis';
import { cycleNotificationContent, requestNotificationPermission, RESULT_NOTIFICATION_CHANNEL } from './notificationPolicy';
import type { DurationRecommendation } from './signalLearning';

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
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        ...cycleNotificationContent(signal, trend ?? 'não informada', confidence, recommendation),
        sound: 'default',
      },
      trigger: Platform.OS === 'android' ? { channelId: RESULT_NOTIFICATION_CHANNEL } : null,
    });
  } catch {
    // Never stop collection, but let the caller report a delivery failure.
    throw new Error('Não foi possível exibir a notificação do resultado.');
  }
}