import { Platform } from 'react-native';
import type { Signal } from './analysis';
import { cycleNotificationContent, requestNotificationPermission } from './notificationPolicy';

export async function prepareNotifications(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const Notifications = await import('expo-notifications');
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('btc-analysis-results', {
        name: 'Resultados dos ciclos BTC',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
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

export async function notifySignal(signal: Signal, confidence: number, trend?: 'ALTA' | 'BAIXA' | 'LATERAL'): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        ...cycleNotificationContent(signal, trend ?? 'não informada', confidence),
      },
      trigger: null,
    });
  } catch {
    // Notifications are best-effort; the signal remains visible in the app.
  }
}