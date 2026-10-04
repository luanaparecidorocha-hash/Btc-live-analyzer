import type { ChartPoint } from './analysis';

export const ANALYSIS_SCENARIOS = ['ALTA', 'BAIXA', 'LATERAL'] as const;
export type AnalysisScenario = typeof ANALYSIS_SCENARIOS[number];

/**
 * Deterministic test inputs only. No connections, timers, storage or decisions.
 * The caller supplies the real engine's window constant and evaluates these
 * inputs with analyzeChart, without advancing or changing the device clock.
 */
export function createAnalysisScenario(scenario: AnalysisScenario, windowMs: number) {
  if (!ANALYSIS_SCENARIOS.includes(scenario)) throw new Error('Cenário de teste inválido.');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('Janela de teste inválida.');
  const sampleIntervalMs = 5_000;
  const basePrice = 80_000;
  const points: ChartPoint[] = Array.from(
    { length: Math.ceil(windowMs / sampleIntervalMs) },
    (_, index) => {
      const timestamp = index * sampleIntervalMs;
      const progress = timestamp / windowMs;
      const changePercent = scenario === 'LATERAL'
        ? Math.sin(2 * Math.PI * timestamp / 60_000) * 0.04
        : (scenario === 'ALTA' ? 0.2 : -0.2) * progress;
      return { timestamp, price: basePrice * (1 + changePercent / 100) };
    },
  );
  return { scenario, points, windowMs, now: windowMs };
}