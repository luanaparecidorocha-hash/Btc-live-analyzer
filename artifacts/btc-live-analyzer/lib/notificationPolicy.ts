import type { Signal } from './analysis';

type Permission = { granted: boolean; canAskAgain: boolean };
export async function requestNotificationPermission(adapter: {
  getPermissions: () => Promise<Permission>;
  requestPermissions: () => Promise<Permission>;
}): Promise<boolean> {
  const current = await adapter.getPermissions();
  const permission = current.granted || !current.canAskAgain
    ? current
    : await adapter.requestPermissions();
  return permission.granted;
}

export function cycleNotificationContent(signal: Signal, trend: string, confidence: number) {
  return {
    title: `Análise de 5 minutos concluída · ${signal}`,
    body: `Tendência: ${trend} · Confirmação: ${confidence}%. Sinais informativos; não executa ordens.`,
  };
}