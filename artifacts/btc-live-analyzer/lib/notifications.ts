import { Platform } from 'react-native';
import type { Signal } from './analysis';

export async function prepareNotifications(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const Notifications = await import('expo-notifications');
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    const permission = await Notifications.requestPermissionsAsync();
    return permission.granted;
  } catch {
    return false;
  }
}

export async function notifySignal(signal: Signal, confidence: number): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const Notifications = await import('expo-notifications');
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Novo sinal BTC: ${signal}`,
        body: `Análise técnica local com ${confidence}% de confiança. Não é garantia de movimento.`,
      },
      trigger: null,
    });
  } catch {
    // Notifications are best-effort; the signal remains visible in the app.
  }
}