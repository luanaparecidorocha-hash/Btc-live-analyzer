import type { ChartPoint, OhlcCandle } from './analysis';

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
  const candleDirections = scenario === 'ALTA'
    ? Array(5).fill('ALTA')
    : scenario === 'BAIXA'
      ? Array(5).fill('BAIXA')
      : ['ALTA', 'BAIXA', 'ALTA', 'BAIXA', 'NEUTRA'];
  let candlePrice = basePrice;
  const candles: OhlcCandle[] = candleDirections.map((direction, index) => {
    const open = candlePrice;
    const change = direction === 'ALTA' ? 0.04 : direction === 'BAIXA' ? -0.04 : 0;
    const close = open * (1 + change / 100);
    const body = Math.abs(close - open);
    const wick = body > 0 ? body / 8 : open * 0.0002;
    candlePrice = close;
    return {
      timestamp: index * 60_000,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
    };
  });
  return { scenario, points, candles, windowMs, now: windowMs };
}