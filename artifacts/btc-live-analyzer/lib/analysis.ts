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

export const DEFAULT_ANALYSIS_WINDOW_MS = 5 * 60 * 1000;

const SAMPLE_INTERVAL_MS = 5 * 1000;
const MIN_POINTS_FOR_SIGNAL = Math.ceil(DEFAULT_ANALYSIS_WINDOW_MS / SAMPLE_INTERVAL_MS / 2);
const MAX_SAMPLE_AGE_MS = 15 * 1000;
const MAX_SAMPLE_GAP_MS = 20 * 1000;
const BUCKET_DURATION_MS = 30 * 1000;
const BUCKET_BOUNDARY_TOLERANCE_MS = 15 * 1000;
const MIN_SIGNAL_MOVE_PERCENT = 0.12;
const MIN_TREND_MOVE_PERCENT = 0.005;
const MIN_BUCKET_MOVE_PERCENT = 0.005;
const MIN_PATH_EFFICIENCY = 0.55;
const MIN_DIRECTIONAL_CONSISTENCY = 0.7;
const MAX_COUNTERTREND_SHARE = 0.2;
const MIN_SIGNAL_CONFIDENCE = 68;

type DirectionalSegments = {
  aligned: number;
  opposed: number;
  total: number;
  consistency: number;
  streak: number;
};

function nearestPriceAt(points: ChartPoint[], timestamp: number): number | null {
  let nearest: ChartPoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const distance = Math.abs(point.timestamp - timestamp);
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return nearest && nearestDistance <= BUCKET_BOUNDARY_TOLERANCE_MS
    ? nearest.price
    : null;
}

function getDirectionalSegments(
  points: ChartPoint[],
  direction: -1 | 0 | 1,
  windowMs: number,
  now: number,
  minimumMovePercent = MIN_BUCKET_MOVE_PERCENT,
): DirectionalSegments {
  if (points.length < 2) {
    return { aligned: 0, opposed: 0, total: 0, consistency: 0, streak: 0 };
  }

  const firstTimestamp = Math.max(points[0].timestamp, now - windowMs);
  const lastTimestamp = Math.min(points[points.length - 1].timestamp, now);
  const observedSpan = lastTimestamp - firstTimestamp;
  const segmentCount = Math.min(
    Math.ceil(windowMs / BUCKET_DURATION_MS),
    Math.round(observedSpan / BUCKET_DURATION_MS),
  );

  if (segmentCount <= 0) {
    return { aligned: 0, opposed: 0, total: 0, consistency: 0, streak: 0 };
  }

  let aligned = 0;
  let opposed = 0;
  let streak = 0;
  let total = 0;

  for (let index = 0; index < segmentCount; index += 1) {
    const segmentStart = firstTimestamp + (observedSpan * index) / segmentCount;
    const segmentEnd = firstTimestamp + (observedSpan * (index + 1)) / segmentCount;
    const startPrice = nearestPriceAt(points, segmentStart);
    const endPrice = nearestPriceAt(points, segmentEnd);

    if (startPrice === null || endPrice === null || startPrice <= 0) continue;

    const changePercent = ((endPrice - startPrice) / startPrice) * 100;
    total += 1;
    if (changePercent * direction >= minimumMovePercent) {
      aligned += 1;
      streak += 1;
    } else {
      streak = 0;
      if (changePercent * direction <= -minimumMovePercent) opposed += 1;
    }
  }

  return {
    aligned,
    opposed,
    total,
    consistency: total > 0 ? aligned / total : 0,
    streak,
  };
}

function classifyTrend(
  points: ChartPoint[],
  priceChangePercent: number,
  windowMs: number,
  now: number,
): AnalysisResult['trend'] {
  // Describing a trend is separate from authorizing a trading signal.
  // Small, sustained moves can be directional without meeting signal thresholds.
  if (points.length < 8 || Math.abs(priceChangePercent) < MIN_TREND_MOVE_PERCENT) return 'LATERAL';
  const direction = priceChangePercent > 0 ? 1 : -1;
  const segments = getDirectionalSegments(points, direction, windowMs, now, 0.0005);
  const span = points[points.length - 1].timestamp - points[0].timestamp;
  if (span <= 0 || segments.total < 2) return 'LATERAL';

  const xs = points.map((point) => (point.timestamp - points[0].timestamp) / span);
  const ys = points.map((point) => ((point.price - points[0].price) / points[0].price) * 100);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index] - meanX;
    const y = ys[index] - meanY;
    covariance += x * y;
    varianceX += x * x;
    varianceY += y * y;
  }
  const fit = varianceX > 0 && varianceY > 0
    ? (covariance * covariance) / (varianceX * varianceY)
    : 0;
  const consistent = covariance * direction > 0
    && fit >= 0.5
    && segments.consistency >= 0.6
    && segments.opposed / segments.total <= 0.3;
  return consistent ? (direction > 0 ? 'ALTA' : 'BAIXA') : 'LATERAL';
}

export function analyzeChart(
  points: ChartPoint[],
  windowMs = DEFAULT_ANALYSIS_WINDOW_MS,
  now = points[points.length - 1]?.timestamp ?? 0,
): AnalysisResult {
  const validPoints = points
    .filter((point) => (
      Number.isFinite(point.timestamp)
      && Number.isFinite(point.price)
      && point.price > 0
      && point.timestamp <= now
    ))
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((point, index, sorted) => index === 0 || point.timestamp > sorted[index - 1].timestamp);

  if (validPoints.length === 0) {
    return {
      signal: 'AGUARDAR',
      trend: 'LATERAL',
      confidence: 0,
      streak: 0,
      slope: 0,
      reason: 'Aguardando a primeira cotação real de BTC/USD.',
    };
  }

  const elapsed = Math.max(0, now - validPoints[0].timestamp);
  const windowStart = now - windowMs;
  const windowPoints = validPoints.filter((point) => point.timestamp >= windowStart);

  if (windowPoints.length === 0) {
    return {
      signal: 'AGUARDAR',
      trend: 'LATERAL',
      confidence: 0,
      streak: 0,
      slope: 0,
      reason: 'Sem cotações recentes suficientes para avaliar a janela de 5 minutos.',
    };
  }

  const firstPrice = windowPoints[0].price;
  const latestPoint = windowPoints[windowPoints.length - 1];
  const latestPrice = latestPoint.price;
  const priceChangePercent = firstPrice > 0 ? ((latestPrice - firstPrice) / firstPrice) * 100 : 0;
  const deltas = windowPoints.slice(1).map((point, index) => {
    const previousPrice = windowPoints[index].price;
    return previousPrice > 0 ? ((point.price - previousPrice) / previousPrice) * 100 : 0;
  });
  const direction: -1 | 0 | 1 = priceChangePercent > 0
    ? 1
    : priceChangePercent < 0
      ? -1
      : 0;
  const segments = getDirectionalSegments(windowPoints, direction, windowMs, now);
  const latestSampleAge = Math.max(0, now - latestPoint.timestamp);
  const observedSpan = latestPoint.timestamp - windowPoints[0].timestamp;
  const maxSampleGap = windowPoints.slice(1).reduce(
    (largest, point, index) => Math.max(largest, point.timestamp - windowPoints[index].timestamp),
    0,
  );
  const totalMovement = deltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
  const pathEfficiency = totalMovement > 0
    ? Math.min(1, Math.abs(priceChangePercent) / totalMovement)
    : 0;
  const movementStrength = Math.min(1, Math.abs(priceChangePercent) / 0.3);
  const rawConfidence = (
    movementStrength * 0.4
    + pathEfficiency * 0.3
    + segments.consistency * 0.3
  ) * 100;
  const trend = classifyTrend(windowPoints, priceChangePercent, windowMs, now);
  const fullWindowCollected = elapsed >= windowMs;
  const requiredSegmentCount = Math.max(1, Math.ceil(windowMs / BUCKET_DURATION_MS) - 1);
  const fullWindowDataQuality = Math.min(
    1,
    windowPoints.length / MIN_POINTS_FOR_SIGNAL,
    observedSpan / Math.max(1, windowMs - 2 * MAX_SAMPLE_AGE_MS),
    MAX_SAMPLE_AGE_MS / Math.max(latestSampleAge, MAX_SAMPLE_AGE_MS),
    MAX_SAMPLE_GAP_MS / Math.max(maxSampleGap, MAX_SAMPLE_GAP_MS),
    MAX_SAMPLE_AGE_MS / Math.max(windowPoints[0].timestamp - windowStart, MAX_SAMPLE_AGE_MS),
    segments.total / requiredSegmentCount,
  );
  const confidence = Math.round(rawConfidence * (fullWindowCollected ? fullWindowDataQuality : 1));
  const resultBase = {
    trend,
    confidence,
    streak: segments.streak,
    slope: priceChangePercent,
  };

  if (!fullWindowCollected) {
    const elapsedSeconds = Math.floor(elapsed / 1000);
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    const remainingSeconds = elapsedSeconds % 60;
    const collected = `${elapsedMinutes}:${String(remainingSeconds).padStart(2, '0')}`;
    return {
      signal: 'AGUARDAR',
      ...resultBase,
      reason: `Coletando preços reais: ${collected} de ${Math.ceil(windowMs / 60000)}:00 antes de avaliar um sinal.`,
    };
  }

  const dataIssues: string[] = [];

  if (windowPoints.length < MIN_POINTS_FOR_SIGNAL) {
    dataIssues.push(`apenas ${windowPoints.length} amostras`);
  }
  if (windowPoints[0].timestamp - windowStart > MAX_SAMPLE_AGE_MS) {
    dataIssues.push('início da janela sem cobertura');
  }
  if (latestSampleAge > MAX_SAMPLE_AGE_MS) {
    dataIssues.push('cotação mais recente desatualizada');
  }
  if (observedSpan < windowMs - 2 * MAX_SAMPLE_AGE_MS) {
    dataIssues.push('cobertura temporal insuficiente');
  }
  if (maxSampleGap > MAX_SAMPLE_GAP_MS) {
    dataIssues.push('lacuna longa entre cotações');
  }
  if (segments.total < Math.ceil(windowMs / BUCKET_DURATION_MS) - 1) {
    dataIssues.push('consistência temporal não pôde ser medida');
  }

  if (dataIssues.length > 0) {
    return {
      signal: 'AGUARDAR',
      ...resultBase,
      reason: `Dados insuficientes na janela de 5 minutos (${dataIssues.join('; ')}).`,
    };
  }

  if (trend === 'LATERAL') {
    return {
      signal: 'AGUARDAR',
      ...resultBase,
      reason: `Variação de ${Math.abs(priceChangePercent).toFixed(2)}% na janela de 5 minutos; tendência inconsistente ou sem direção clara. AGUARDAR.`,
    };
  }

  const consistencyLabel = `${segments.aligned}/${segments.total} períodos`;
  const countertrendLabel = `${segments.opposed}/${segments.total} contra`;
  const movementLabel = `${Math.abs(priceChangePercent).toFixed(2)}%`;
  const signalIssues: string[] = [];

  if (Math.abs(priceChangePercent) < MIN_SIGNAL_MOVE_PERCENT) {
    signalIssues.push(`variação de ${movementLabel} abaixo do mínimo de ${MIN_SIGNAL_MOVE_PERCENT.toFixed(2)}%`);
  }
  if (
    segments.consistency < MIN_DIRECTIONAL_CONSISTENCY
    || segments.opposed / segments.total > MAX_COUNTERTREND_SHARE
  ) {
    signalIssues.push(`tendência inconsistente (${consistencyLabel} na direção, ${countertrendLabel})`);
  }
  if (pathEfficiency < MIN_PATH_EFFICIENCY) {
    signalIssues.push(`trajetória irregular (${Math.round(pathEfficiency * 100)}% de eficiência)`);
  }
  if (segments.streak === 0) {
    signalIssues.push('fim da janela não confirma a direção geral');
  }
  if (confidence < MIN_SIGNAL_CONFIDENCE) {
    signalIssues.push(`força agregada de ${confidence}% abaixo do mínimo de ${MIN_SIGNAL_CONFIDENCE}%`);
  }

  if (signalIssues.length > 0) {
    return {
      signal: 'AGUARDAR',
      ...resultBase,
      reason: `Movimento de ${movementLabel}, mas ${signalIssues.slice(0, 2).join('; ')}. AGUARDAR.`,
    };
  }

  const signal = direction > 0 ? 'POSSÍVEL COMPRA' : 'POSSÍVEL VENDA';
  const movementVerb = direction > 0 ? 'subiu' : 'caiu';
  return {
    signal,
    ...resultBase,
    reason: `BTC/USD ${movementVerb} ${movementLabel} em 5 min; ${consistencyLabel} na direção e ${Math.round(pathEfficiency * 100)}% de eficiência. Confirmação mede a força dos sinais, não a chance de acerto.`,
  };
}

export function trimHistory(points: ChartPoint[], now = Date.now()): ChartPoint[] {
  const cutoff = now - DEFAULT_ANALYSIS_WINDOW_MS;
  let firstCurrentPoint = points.findIndex((point) => point.timestamp >= cutoff);
  if (firstCurrentPoint < 0) return points.length > 0 ? [points[points.length - 1]] : [];
  if (firstCurrentPoint > 0) firstCurrentPoint -= 1;
  return points.slice(firstCurrentPoint);
}

export type DeadlineScheduler = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

const systemDeadlineScheduler: DeadlineScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export function scheduleAnalysisDeadline(
  collectionStartedAt: number,
  onComplete: (completedAt: number) => void,
  scheduler: DeadlineScheduler = systemDeadlineScheduler,
): () => void {
  const completedAt = collectionStartedAt + DEFAULT_ANALYSIS_WINDOW_MS;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;

  const checkDeadline = () => {
    if (cancelled) return;
    const remainingMs = completedAt - scheduler.now();
    if (remainingMs > 0) {
      timer = scheduler.setTimeout(checkDeadline, remainingMs);
      return;
    }
    cancelled = true;
    onComplete(completedAt);
  };

  timer = scheduler.setTimeout(
    checkDeadline,
    Math.max(0, completedAt - scheduler.now()),
  );

  return () => {
    cancelled = true;
    scheduler.clearTimeout(timer);
  };
}
