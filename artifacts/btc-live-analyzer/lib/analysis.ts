export type Signal = 'POSSÍVEL COMPRA' | 'POSSÍVEL VENDA' | 'AGUARDAR';

export type ChartPoint = {
  timestamp: number;
  price: number;
};

export type AnalysisResult = {
  signal: Signal;
  trend: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  streak: number;
  slope: number;
  reason: string;
};

const MIN_POINTS_FOR_SIGNAL = 8;
export const DEFAULT_ANALYSIS_WINDOW_MS = 5 * 60 * 1000;

export function analyzeChart(
  points: ChartPoint[],
  windowMs = DEFAULT_ANALYSIS_WINDOW_MS,
  now = points[points.length - 1]?.timestamp ?? 0,
): AnalysisResult {
  if (points.length === 0) {
    return {
      signal: 'AGUARDAR',
      trend: 'LATERAL',
      confidence: 0,
      streak: 0,
      slope: 0,
      reason: 'Aguardando a primeira cotação real de BTC/USD.',
    };
  }

  const elapsed = Math.max(0, now - points[0].timestamp);
  const windowStart = now - windowMs;
  let firstInWindow = points.findIndex((point) => point.timestamp >= windowStart);
  if (firstInWindow < 0) firstInWindow = points.length - 1;
  if (firstInWindow > 0) firstInWindow -= 1;
  const windowPoints = points.slice(firstInWindow);
  const firstPrice = windowPoints[0].price;
  const latestPrice = points[points.length - 1].price;
  const priceChangePercent = firstPrice > 0 ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0;
  const deltas = windowPoints.slice(1).map((point, index) => {
    const previousPrice = windowPoints[index].price;
    return previousPrice > 0 ? ((point.price - previousPrice) / previousPrice) * 100 : 0;
  });
  const minimumDirectionMovePercent = Math.max(
    0.015,
    0.08 * Math.min(1, elapsed / windowMs),
  );
  const direction = priceChangePercent > minimumDirectionMovePercent
    ? 1
    : priceChangePercent < -minimumDirectionMovePercent
      ? -1
      : 0;
  let streak = 0;

  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    const deltaDirection = deltas[index] > 0.003 ? 1 : deltas[index] < -0.003 ? -1 : 0;
    if (direction === 0 || deltaDirection !== direction) break;
    streak += 1;
  }

  const totalMovement = deltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
  const pathEfficiency = totalMovement > 0
    ? Math.min(1, Math.abs(priceChangePercent) / totalMovement)
    : 0;
  const movementStrength = Math.min(1, Math.abs(priceChangePercent) / 0.35);
  const confidence = Math.round((movementStrength * 0.65 + pathEfficiency * 0.35) * 100);
  const trend = direction > 0 ? 'ALTA' : direction < 0 ? 'BAIXA' : 'LATERAL';
  const fullWindowCollected = elapsed >= windowMs;

  if (fullWindowCollected && points.length >= MIN_POINTS_FOR_SIGNAL && direction > 0 && confidence >= 68 && streak >= 3) {
    return {
      signal: 'POSSÍVEL COMPRA',
      trend,
      confidence,
      streak,
      slope: priceChangePercent,
      reason: `BTC/USD subiu ${priceChangePercent.toFixed(2)}% na janela real de 5 minutos.`,
    };
  }

  if (fullWindowCollected && points.length >= MIN_POINTS_FOR_SIGNAL && direction < 0 && confidence >= 68 && streak >= 3) {
    return {
      signal: 'POSSÍVEL VENDA',
      trend,
      confidence,
      streak,
      slope: priceChangePercent,
      reason: `BTC/USD caiu ${Math.abs(priceChangePercent).toFixed(2)}% na janela real de 5 minutos.`,
    };
  }

  if (!fullWindowCollected) {
    const elapsedSeconds = Math.floor(elapsed / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const remainingSeconds = elapsedSeconds % 60;
    const collected = `${elapsedMinutes}:${String(remainingSeconds).padStart(2, '0')}`;
    return {
      signal: 'AGUARDAR',
      trend,
      confidence,
      streak,
      slope: priceChangePercent,
      reason: `Coletando preços reais: ${collected} de ${Math.ceil(windowMs / 60000)}:00 antes de avaliar um sinal.`,
    };
  }

  return {
    signal: 'AGUARDAR',
    trend,
    confidence,
    streak,
    slope: priceChangePercent,
    reason: direction === 0
      ? 'Variação de BTC/USD sem tendência clara na janela de 5 minutos.'
      : 'Tendência identificada, mas sem confirmação suficiente nos preços reais.',
  };
}

export function trimHistory(points: ChartPoint[], now = Date.now()): ChartPoint[] {
  const cutoff = now - DEFAULT_ANALYSIS_WINDOW_MS;
  let firstCurrentPoint = points.findIndex((point) => point.timestamp >= cutoff);
  if (firstCurrentPoint < 0) return points.length > 0 ? [points[points.length - 1]] : [];
  if (firstCurrentPoint > 0) firstCurrentPoint -= 1;
  return points.slice(firstCurrentPoint);
}