import type { Signal } from './analysis';
import type { DurationRecommendation } from './signalLearning';

export const RESULT_NOTIFICATION_CHANNEL = 'btc-analysis-results';

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

export function cycleNotificationContent(signal: Signal, trend: string, confidence: number, recommendation: DurationRecommendation = null) {
  const learning = signal === 'AGUARDAR'
    ? 'AGUARDAR: critérios atuais não atendidos; nenhuma duração é recomendada.'
    : recommendation
      ? `Melhor duração histórica: ${recommendation.minutes} minutos\nTaxa de acerto histórica: ${recommendation.hitRate.toFixed(1)}%\nAmostras: ${recommendation.samples}`
      : 'Sistema ainda está aprendendo: dados insuficientes para recomendar uma duração.';
  return {
    title: `Análise de 5 minutos concluída · ${signal}`,
    body: `Tendência: ${trend} · Confirmação: ${confidence}%.\n${learning}\nDesempenho passado não garante resultados. Sinais informativos; não executa ordens.`,
  };
}