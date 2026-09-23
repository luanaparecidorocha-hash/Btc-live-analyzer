export type Signal = 'POSSÍVEL COMPRA' | 'POSSÍVEL VENDA' | 'AGUARDAR';

export type ChartPoint = {
  timestamp: number;
  position: number;
};

export type AnalysisResult = {
  signal: Signal;
  trend: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  streak: number;
  slope: number;
  reason: string;
};

const MIN_POINTS_FOR_SIGNAL = 4;
export const DEFAULT_ANALYSIS_WINDOW_MS = 5 * 60 * 1000;

export function analyzeChart(points: ChartPoint[], windowMs = DEFAULT_ANALYSIS_WINDOW_MS): AnalysisResult {
  const elapsed = points.length > 1 ? points[points.length - 1].timestamp - points[0].timestamp : 0;
  if (points.length < MIN_POINTS_FOR_SIGNAL || elapsed < windowMs) {
    return {
      signal: 'AGUARDAR',
      trend: 'LATERAL',
      confidence: 0,
      streak: 0,
      slope: 0,
      reason: `Aguardando uma janela mínima de ${Math.ceil(windowMs / 60000)} minutos de dados reais.`,
    };
  }

  const recent = points.slice(-12);
  const deltas = recent.slice(1).map((point, index) => point.position - recent[index].position);
  const slope = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  const threshold = 0.7;
  const direction = slope > threshold ? 1 : slope < -threshold ? -1 : 0;
  let streak = 0;

  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    const deltaDirection = deltas[index] > 0 ? 1 : deltas[index] < 0 ? -1 : 0;
    if (deltaDirection === 0 || (streak > 0 && deltaDirection !== direction)) break;
    if (direction !== 0) streak += 1;
  }

  const movementStrength = Math.min(1, Math.abs(slope) / 4);
  const consistency = deltas.filter((delta) => (delta > 0 ? 1 : delta < 0 ? -1 : 0) === direction).length / deltas.length;
  const confidence = Math.round((movementStrength * 0.55 + consistency * 0.45) * 100);
  const trend = direction > 0 ? 'ALTA' : direction < 0 ? 'BAIXA' : 'LATERAL';

  if (direction > 0 && confidence >= 68 && streak >= 3) {
    return {
      signal: 'POSSÍVEL COMPRA',
      trend,
      confidence,
      streak,
      slope,
      reason: 'Movimento ascendente consistente no recorte analisado.',
    };
  }

  if (direction < 0 && confidence >= 68 && streak >= 3) {
    return {
      signal: 'POSSÍVEL VENDA',
      trend,
      confidence,
      streak,
      slope,
      reason: 'Movimento descendente consistente no recorte analisado.',
    };
  }

  return {
    signal: 'AGUARDAR',
    trend,
    confidence,
    streak,
    slope,
    reason: direction === 0 ? 'Sem tendência curta clara neste momento.' : 'Tendência identificada, mas sem confirmação suficiente.',
  };
}

export function trimHistory(points: ChartPoint[], now = Date.now()): ChartPoint[] {
  const cutoff = now - 5 * 60 * 1000;
  return points.filter((point) => point.timestamp >= cutoff);
}