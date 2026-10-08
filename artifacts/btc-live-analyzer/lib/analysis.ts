import type { CrossConfirmation } from './crossConfirmation';

export type Signal = 'POSSÍVEL COMPRA' | 'POSSÍVEL VENDA' | 'AGUARDAR';

export type ChartPoint = {
  timestamp: number;
  price: number;
};

/** Real exchange OHLC candle; timestamp is the start of its 1-minute interval. */
export type OhlcCandle = Readonly<{
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}>;

export type CandleDirection = 'ALTA' | 'BAIXA' | 'NEUTRA';

export type CandleFeatures = Readonly<{
  timestamp: number;
  direction: CandleDirection;
  bodySize: number;
  rangeSize: number;
  upperWick: number;
  lowerWick: number;
  bodyRangeRatio: number;
  closePosition: number;
  bodyPercent: number;
  relativeStrength: number;
}>;

export type AnalysisResult = {
  signal: Signal;
  trend: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  streak: number;
  slope: number;
  reason: string;
  dataStatus?: 'INSUFICIENTES' | 'COLETANDO' | 'SUFICIENTES';
  crossConfirmation?: CrossConfirmation;
};

export const DEFAULT_ANALYSIS_WINDOW_MS = 5 * 60 * 1000;

/**
 * First candle-engine calibration. Evidence categories have equal weight because
 * this project has no labelled candle-outcome dataset to justify unequal weights.
 * Direction, reversal, coverage and cross-source checks remain independent vetoes.
 */
export const CANDLE_ANALYSIS_CONFIG = Object.freeze({
  candleDurationMs: 60_000,
  minClosedCandles: 3,
  minCandleSpanMs: 120_000,
  maxCandleGapMs: 120_000,
  maxLastCandleAgeMs: 120_000,
  maxLatestQuoteAgeMs: 15_000,
  dojiBodyRangeMax: 0.12,
  minDirectionalCandleShare: 0.7,
  minTrendCandleShare: 0.6,
  minEvidenceConfidence: 68,
  movementReferencePercent: 0.12,
  minTrendFit: 0.25,
  breakoutLookbackCandles: 5,
  reversalTailCandles: 2,
  reversalPrecedingShare: 0.6,
  reversalMinBodyRange: 0.45,
  reversalLastBodyRange: 0.6,
  evidenceWeights: Object.freeze({
    candleDirection: 0.2,
    candleStrength: 0.2,
    wickBehavior: 0.2,
    priceMovement: 0.2,
    trendStructure: 0.2,
  }),
});

/**
 * Last-candle thresholds are relative to the average body of candles that
 * support the preceding direction. Penalty units use one candle's share of
 * the existing direction evidence (20 points / five 1-minute candles).
 */
export const LAST_CANDLE_CALIBRATION = Object.freeze({
  correctionMaxRelativeBody: 0.75,
  possibleReversalMinRelativeBody: 1.5,
  possibleReversalMinBodyRange: CANDLE_ANALYSIS_CONFIG.reversalLastBodyRange,
  countertrendCloseExtremeShare: 0.2,
  trendSideRejectionWickMinShare: 0.35,
  previousMoveErasureShare: 0.5,
  moderatePenaltyVotes: 1,
  reversalPenaltyVotes: 2,
});

type Direction = -1 | 0 | 1;
type LastCandleEffect = 'NENHUM' | 'CORRECAO_NORMAL' | 'PERDA_DE_FORCA' | 'POSSIVEL_REVERSAO';

type CandleEvidence = {
  candles: CandleFeatures[];
  direction: Direction;
  directionShare: number;
  neutralShare: number;
  wickScore: number;
  strengthScore: number;
  movementScore: number;
  structureScore: number;
  priceChangePercent: number;
  trendFit: number;
  breakoutDirection: Direction;
  reversal: boolean;
  lastCandleReversal: boolean;
  lastCandleEffect: LastCandleEffect;
  lastCandlePenaltyPoints: number;
  streak: number;
  confidence: number;
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validCandle(candle: OhlcCandle): boolean {
  return Number.isSafeInteger(candle.timestamp)
    && candle.timestamp >= 0
    && [candle.open, candle.high, candle.low, candle.close]
      .every((value) => Number.isFinite(value) && value > 0)
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low;
}

/** Shared by the engine and chart so rendered candles match the analyzed OHLC. */
export function selectClosedCandlesInWindow(
  candles: readonly OhlcCandle[],
  windowStart: number,
  now: number,
): OhlcCandle[] {
  if (!Number.isFinite(windowStart) || !Number.isFinite(now) || now < windowStart) return [];
  const unique = new Map<number, OhlcCandle>();
  for (const candle of candles) {
    if (validCandle(candle)
      && candle.timestamp >= windowStart
      && candle.timestamp + CANDLE_ANALYSIS_CONFIG.candleDurationMs <= now) {
      unique.set(candle.timestamp, candle);
    }
  }
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function analyzeCandleFeatures(
  candle: OhlcCandle,
  averageBodyPercent?: number,
): CandleFeatures {
  const rangeSize = candle.high - candle.low;
  const bodySize = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const bodyRangeRatio = rangeSize > 0 ? clamp01(bodySize / rangeSize) : 0;
  const bodyPercent = candle.open > 0 ? (bodySize / candle.open) * 100 : 0;
  const relativeSize = averageBodyPercent && averageBodyPercent > 0
    ? clamp01(bodyPercent / averageBodyPercent)
    : bodyRangeRatio > 0 ? 1 : 0;
  const direction: CandleDirection = bodyRangeRatio <= CANDLE_ANALYSIS_CONFIG.dojiBodyRangeMax
    ? 'NEUTRA'
    : candle.close > candle.open ? 'ALTA'
      : candle.close < candle.open ? 'BAIXA' : 'NEUTRA';

  return Object.freeze({
    timestamp: candle.timestamp,
    direction,
    bodySize,
    rangeSize,
    upperWick: Math.max(0, upperWick),
    lowerWick: Math.max(0, lowerWick),
    bodyRangeRatio,
    closePosition: rangeSize > 0 ? clamp01((candle.close - candle.low) / rangeSize) : 0.5,
    bodyPercent,
    relativeStrength: bodyRangeRatio * relativeSize,
  });
}

function regressionFit(candles: readonly OhlcCandle[], direction: Direction): number {
  if (candles.length < 2 || direction === 0) return 0;
  const xs = candles.map((_, index) => index);
  const base = candles[0].open;
  const ys = candles.map((candle) => ((candle.close - base) / base) * 100);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
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
  if (varianceX === 0 || varianceY === 0 || covariance * direction <= 0) return 0;
  return clamp01((covariance * covariance) / (varianceX * varianceY));
}

function getBreakoutDirection(
  allClosedCandles: readonly OhlcCandle[],
  windowCandles: readonly OhlcCandle[],
  windowStart: number,
): Direction {
  const count = CANDLE_ANALYSIS_CONFIG.breakoutLookbackCandles;
  if (windowCandles.length === 0) return 0;
  const previous = allClosedCandles
    .filter((candle) => (
      candle.timestamp < windowStart
      && candle.timestamp + CANDLE_ANALYSIS_CONFIG.candleDurationMs <= windowStart
    ))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-count);
  if (previous.length !== count) return 0;
  for (let index = 1; index < previous.length; index += 1) {
    if (previous[index].timestamp - previous[index - 1].timestamp
      !== CANDLE_ANALYSIS_CONFIG.candleDurationMs) return 0;
  }

  const priorHigh = Math.max(...previous.map((candle) => candle.high));
  const priorLow = Math.min(...previous.map((candle) => candle.low));
  const lastClose = windowCandles[windowCandles.length - 1].close;
  if (lastClose > priorHigh) return 1;
  if (lastClose < priorLow) return -1;
  return 0;
}

function hasStrongReversal(features: readonly CandleFeatures[], direction: Direction): boolean {
  const tailCount = CANDLE_ANALYSIS_CONFIG.reversalTailCandles;
  if (direction === 0 || features.length < tailCount + 2) return false;
  const preceding = features.slice(0, -tailCount);
  const directional = preceding.filter((feature) => feature.direction !== 'NEUTRA');
  if (directional.length < 2) return false;
  const up = directional.filter((feature) => feature.direction === 'ALTA').length;
  const down = directional.length - up;
  const priorDirection: Direction = up > down ? 1 : down > up ? -1 : 0;
  if (priorDirection === 0 || Math.max(up, down) / directional.length
    < CANDLE_ANALYSIS_CONFIG.reversalPrecedingShare) return false;

  const tail = features.slice(-tailCount);
  return tail.every((feature) => (
    feature.direction === (priorDirection > 0 ? 'BAIXA' : 'ALTA')
    && feature.bodyRangeRatio >= CANDLE_ANALYSIS_CONFIG.reversalMinBodyRange
  ));
}

function assessLastCountertrendCandle(
  windowCandles: readonly OhlcCandle[],
  features: readonly CandleFeatures[],
  direction: Direction,
  breakoutDirection: Direction,
): { penaltyPoints: number; possibleReversal: boolean; effect: LastCandleEffect } {
  if (direction === 0 || windowCandles.length < 2 || features.length !== windowCandles.length) {
    return { penaltyPoints: 0, possibleReversal: false, effect: 'NENHUM' };
  }

  const expectedDirection = direction > 0 ? 'ALTA' : 'BAIXA';
  const counterDirection = direction > 0 ? 'BAIXA' : 'ALTA';
  const lastFeature = features[features.length - 1];
  if (lastFeature.direction !== counterDirection) {
    return { penaltyPoints: 0, possibleReversal: false, effect: 'NENHUM' };
  }

  const priorAlignedBodies = features.slice(0, -1)
    .filter((feature) => feature.direction === expectedDirection)
    .map((feature) => feature.bodyPercent);
  const averagePriorBody = priorAlignedBodies.length > 0
    ? priorAlignedBodies.reduce((sum, value) => sum + value, 0) / priorAlignedBodies.length
    : 0;
  if (averagePriorBody <= 0) return { penaltyPoints: 0, possibleReversal: false, effect: 'NENHUM' };

  const relativeBody = lastFeature.bodyPercent / averagePriorBody;
  const trendSideWick = direction > 0 ? lastFeature.lowerWick : lastFeature.upperWick;
  const trendSideWickShare = lastFeature.rangeSize > 0
    ? trendSideWick / lastFeature.rangeSize
    : 0;
  const hasStrongRejection = trendSideWickShare
      >= LAST_CANDLE_CALIBRATION.trendSideRejectionWickMinShare
    && (direction > 0
      ? lastFeature.closePosition > LAST_CANDLE_CALIBRATION.countertrendCloseExtremeShare
      : lastFeature.closePosition < 1 - LAST_CANDLE_CALIBRATION.countertrendCloseExtremeShare);

  // A small body or a clear rejection wick is treated as an ordinary correction.
  if (relativeBody < LAST_CANDLE_CALIBRATION.correctionMaxRelativeBody || hasStrongRejection) {
    return { penaltyPoints: 0, possibleReversal: false, effect: 'CORRECAO_NORMAL' };
  }

  const votePoints = 100 * CANDLE_ANALYSIS_CONFIG.evidenceWeights.candleDirection
    / (DEFAULT_ANALYSIS_WINDOW_MS / CANDLE_ANALYSIS_CONFIG.candleDurationMs);
  const moderatePenalty = Math.round(votePoints * LAST_CANDLE_CALIBRATION.moderatePenaltyVotes);
  const strongEnough = relativeBody >= LAST_CANDLE_CALIBRATION.possibleReversalMinRelativeBody
    && lastFeature.bodyRangeRatio >= LAST_CANDLE_CALIBRATION.possibleReversalMinBodyRange;
  if (!strongEnough) {
    return { penaltyPoints: moderatePenalty, possibleReversal: false, effect: 'PERDA_DE_FORCA' };
  }

  const lastCandle = windowCandles[windowCandles.length - 1];
  const previousCandle = windowCandles[windowCandles.length - 2];
  const closesAtCountertrendExtreme = direction > 0
    ? lastFeature.closePosition <= LAST_CANDLE_CALIBRATION.countertrendCloseExtremeShare
    : lastFeature.closePosition >= 1 - LAST_CANDLE_CALIBRATION.countertrendCloseExtremeShare;
  const breaksPreviousCandle = direction > 0
    ? lastCandle.close < previousCandle.low
    : lastCandle.close > previousCandle.high;
  const previousFavorableMovePercent = direction
    * ((previousCandle.close - windowCandles[0].open) / windowCandles[0].open) * 100;
  const erasesSignificantMove = previousFavorableMovePercent > 0
    && lastFeature.bodyPercent / previousFavorableMovePercent
      >= LAST_CANDLE_CALIBRATION.previousMoveErasureShare;
  const oppositeBreakout = breakoutDirection === -direction;
  const possibleReversal = closesAtCountertrendExtreme
    && (breaksPreviousCandle || erasesSignificantMove || oppositeBreakout);

  return {
    penaltyPoints: possibleReversal
      ? Math.round(votePoints * LAST_CANDLE_CALIBRATION.reversalPenaltyVotes)
      : moderatePenalty,
    possibleReversal,
    effect: possibleReversal ? 'POSSIVEL_REVERSAO' : 'PERDA_DE_FORCA',
  };
}

function trailingDirectionStreak(features: readonly CandleFeatures[], direction: Direction): number {
  if (direction === 0) return 0;
  let streak = 0;
  for (let index = features.length - 1; index >= 0; index -= 1) {
    const aligned = features[index].direction === (direction > 0 ? 'ALTA' : 'BAIXA');
    if (!aligned) break;
    streak += 1;
  }
  return streak;
}

function calculateCandleEvidence(
  windowCandles: readonly OhlcCandle[],
  allClosedCandles: readonly OhlcCandle[],
  windowStart: number,
): CandleEvidence {
  const first = windowCandles[0];
  const last = windowCandles[windowCandles.length - 1];
  const priceChangePercent = first && last
    ? ((last.close - first.open) / first.open) * 100
    : 0;
  const directionVotes = windowCandles.reduce((sum, candle) => (
    sum + (candle.close > candle.open ? 1 : candle.close < candle.open ? -1 : 0)
  ), 0);
  const direction: Direction = priceChangePercent > 0 ? 1
    : priceChangePercent < 0 ? -1
      : directionVotes > 0 ? 1 : directionVotes < 0 ? -1 : 0;
  const averageBodyPercent = windowCandles.length > 0
    ? windowCandles.reduce((sum, candle) => sum + Math.abs(candle.close - candle.open) / candle.open * 100, 0)
      / windowCandles.length
    : 0;
  const features = windowCandles.map((candle) => analyzeCandleFeatures(candle, averageBodyPercent));
  const alignedDirection = direction > 0 ? 'ALTA' : direction < 0 ? 'BAIXA' : null;
  const aligned = alignedDirection
    ? features.filter((feature) => feature.direction === alignedDirection)
    : [];
  const neutralShare = features.length > 0
    ? features.filter((feature) => feature.direction === 'NEUTRA').length / features.length
    : 1;
  const directionShare = features.length > 0 ? aligned.length / features.length : 0;
  const strengthScore = aligned.length > 0
    ? aligned.reduce((sum, feature) => sum + feature.relativeStrength, 0) / aligned.length
    : 0;
  const wickScore = aligned.length > 0
    ? aligned.reduce((sum, feature) => {
        const opposingWick = direction > 0 ? feature.upperWick : feature.lowerWick;
        const opposingWickShare = feature.rangeSize > 0 ? opposingWick / feature.rangeSize : 0;
        const closeSupport = direction > 0 ? feature.closePosition : 1 - feature.closePosition;
        return sum + clamp01((1 - opposingWickShare + closeSupport) / 2);
      }, 0) / aligned.length
    : 0;
  const movementScore = clamp01(
    Math.abs(priceChangePercent) / CANDLE_ANALYSIS_CONFIG.movementReferencePercent,
  );
  const trendFit = regressionFit(windowCandles, direction);
  const half = Math.ceil(features.length / 2);
  const firstHalf = features.slice(0, half);
  const secondHalf = features.slice(half);
  const signedBodyPercent = (feature: CandleFeatures) => (
    (feature.direction === 'ALTA' ? 1 : feature.direction === 'BAIXA' ? -1 : 0)
      * feature.bodyPercent * direction
  );
  const mean = (values: readonly CandleFeatures[]) => values.length > 0
    ? values.reduce((sum, feature) => sum + signedBodyPercent(feature), 0) / values.length
    : 0;
  const avgBody = features.length > 0
    ? features.reduce((sum, feature) => sum + feature.bodyPercent, 0) / features.length
    : 0;
  const bodyMomentum = avgBody > 0
    ? clamp01(0.5 + (mean(secondHalf) - mean(firstHalf)) / (2 * avgBody))
    : 0.5;
  const breakoutDirection = getBreakoutDirection(allClosedCandles, windowCandles, windowStart);
  const structureParts = [trendFit, bodyMomentum];
  if (breakoutDirection !== 0) structureParts.push(breakoutDirection === direction ? 1 : 0);
  const structureScore = structureParts.reduce((sum, value) => sum + value, 0) / structureParts.length;
  const weights = CANDLE_ANALYSIS_CONFIG.evidenceWeights;
  const baseConfidence = Math.round(100 * (
    directionShare * weights.candleDirection
    + strengthScore * weights.candleStrength
    + wickScore * weights.wickBehavior
    + movementScore * weights.priceMovement
    + structureScore * weights.trendStructure
  ));
  const lastCountertrend = assessLastCountertrendCandle(
    windowCandles,
    features,
    direction,
    breakoutDirection,
  );
  const confidence = Math.max(0, baseConfidence - lastCountertrend.penaltyPoints);

  return {
    candles: features,
    direction,
    directionShare,
    neutralShare,
    wickScore,
    strengthScore,
    movementScore,
    structureScore,
    priceChangePercent,
    trendFit,
    breakoutDirection,
    reversal: hasStrongReversal(features, direction) || lastCountertrend.possibleReversal,
    lastCandleReversal: lastCountertrend.possibleReversal,
    lastCandleEffect: lastCountertrend.effect,
    lastCandlePenaltyPoints: lastCountertrend.penaltyPoints,
    streak: trailingDirectionStreak(features, direction),
    confidence,
  };
}

function waitResult(
  reason: string,
  dataStatus: NonNullable<AnalysisResult['dataStatus']>,
  evidence?: CandleEvidence,
): AnalysisResult {
  return {
    signal: 'AGUARDAR',
    trend: evidence?.direction === 1 ? 'ALTA' : evidence?.direction === -1 ? 'BAIXA' : 'LATERAL',
    confidence: evidence?.confidence ?? 0,
    streak: evidence?.streak ?? 0,
    slope: evidence?.priceChangePercent ?? 0,
    reason,
    dataStatus,
  };
}

function lastCandleNote(evidence: CandleEvidence): string {
  if (evidence.lastCandleEffect === 'CORRECAO_NORMAL') {
    return ' O último candle contrário foi tratado como correção normal, sem penalidade adicional.';
  }
  if (evidence.lastCandleEffect === 'PERDA_DE_FORCA') {
    return ` O último candle contrário reduziu ${evidence.lastCandlePenaltyPoints} pontos por perda de força.`;
  }
  return '';
}

export function analyzeChart(
  points: ChartPoint[],
  windowMs = DEFAULT_ANALYSIS_WINDOW_MS,
  now = points[points.length - 1]?.timestamp ?? 0,
  candles: readonly OhlcCandle[] = [],
): AnalysisResult {
  const validPoints = points
    .filter((point) => Number.isFinite(point.timestamp)
      && Number.isFinite(point.price) && point.price > 0 && point.timestamp <= now)
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter((point, index, sorted) => index === 0 || point.timestamp > sorted[index - 1].timestamp);

  if (validPoints.length === 0) {
    return waitResult('Aguardando a primeira cotação real para iniciar o ciclo de 5 minutos.', 'INSUFICIENTES');
  }

  const elapsed = Math.max(0, now - validPoints[0].timestamp);
  const windowStart = now - windowMs;
  const fullWindowCollected = elapsed >= windowMs;
  const closedCandles = [...new Map(candles
    .filter((candle) => validCandle(candle)
      && candle.timestamp + CANDLE_ANALYSIS_CONFIG.candleDurationMs <= now)
    .map((candle) => [candle.timestamp, candle])).values()]
    .sort((left, right) => left.timestamp - right.timestamp);
  const windowCandles = selectClosedCandlesInWindow(closedCandles, windowStart, now);
  const evidence = calculateCandleEvidence(windowCandles, closedCandles, windowStart);
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const collected = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  if (!fullWindowCollected) {
    return waitResult(
      `Coletando dados reais: ${collected} de ${Math.ceil(windowMs / 60000)}:00; a decisão final aguarda o ciclo completo e candles de 1 minuto fechados.`,
      'COLETANDO',
      evidence,
    );
  }

  // Quotes still establish that each source is live; the signal itself is
  // computed from OHLC, not these price samples.
  const latestQuote = validPoints[validPoints.length - 1];
  if (now - latestQuote.timestamp > CANDLE_ANALYSIS_CONFIG.maxLatestQuoteAgeMs) {
    return waitResult(
      'Cotação da fonte desatualizada; não é seguro confirmar o sinal sem uma conexão ao vivo.',
      'INSUFICIENTES',
      evidence,
    );
  }

  const { minClosedCandles, minCandleSpanMs, maxCandleGapMs, maxLastCandleAgeMs } = CANDLE_ANALYSIS_CONFIG;
  if (windowCandles.length < minClosedCandles) {
    return waitResult(
      `Dados OHLC insuficientes: ${windowCandles.length} candles de 1 minuto fechados; são necessários pelo menos ${minClosedCandles}.`,
      'INSUFICIENTES',
      evidence,
    );
  }

  const firstCandle = windowCandles[0];
  const latestCandle = windowCandles[windowCandles.length - 1];
  const candleSpan = latestCandle.timestamp - firstCandle.timestamp;
  const largestCandleGap = windowCandles.slice(1).reduce(
    (largest, candle, index) => Math.max(largest, candle.timestamp - windowCandles[index].timestamp),
    0,
  );
  const latestCandleAge = now - (latestCandle.timestamp + CANDLE_ANALYSIS_CONFIG.candleDurationMs);
  if (candleSpan < minCandleSpanMs
    || largestCandleGap > maxCandleGapMs
    || latestCandleAge > maxLastCandleAgeMs) {
    const problems = [
      candleSpan < minCandleSpanMs ? 'cobertura OHLC curta' : null,
      largestCandleGap > maxCandleGapMs ? 'lacuna de candles' : null,
      latestCandleAge > maxLastCandleAgeMs ? 'último candle fechado desatualizado' : null,
    ].filter(Boolean).join('; ');
    return waitResult(`Dados OHLC insuficientes na janela: ${problems}.`, 'INSUFICIENTES', evidence);
  }

  if (evidence.direction === 0) {
    return waitResult('Candles sem direção predominante; AGUARDAR.', 'SUFICIENTES', evidence);
  }

  const trend = evidence.direction === 1 ? 'ALTA' : 'BAIXA';
  const alignedLabel = `${Math.round(evidence.directionShare * 100)}% dos candles alinhados`;
  if (evidence.reversal) {
    return {
      signal: 'AGUARDAR', trend, confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: evidence.lastCandleReversal
        ? 'Último candle contrário forte, com fechamento extremo e rompimento ou retração estrutural; possível reversão. AGUARDAR.'
        : 'Dois candles fortes no fim da janela indicam possível reversão. AGUARDAR.',
    };
  }
  if (evidence.breakoutDirection !== 0 && evidence.breakoutDirection !== evidence.direction) {
    return {
      signal: 'AGUARDAR', trend, confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: 'Rompimento recente contrário à direção predominante dos candles. AGUARDAR.',
    };
  }
  if (evidence.directionShare < CANDLE_ANALYSIS_CONFIG.minTrendCandleShare
    || evidence.trendFit < CANDLE_ANALYSIS_CONFIG.minTrendFit) {
    return {
      signal: 'AGUARDAR', trend: 'LATERAL', confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: 'A sequência de candles não sustenta uma tendência estável. AGUARDAR.',
    };
  }
  if (evidence.directionShare < CANDLE_ANALYSIS_CONFIG.minDirectionalCandleShare) {
    return {
      signal: 'AGUARDAR', trend, confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: `Sequência indecisa: ${alignedLabel}; direção mínima necessária ${Math.round(CANDLE_ANALYSIS_CONFIG.minDirectionalCandleShare * 100)}%. AGUARDAR.`,
    };
  }
  if (evidence.neutralShare >= 0.5) {
    return {
      signal: 'AGUARDAR', trend, confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: 'Muitos candles neutros/doji indicam indecisão. AGUARDAR.',
    };
  }
  if (evidence.confidence < CANDLE_ANALYSIS_CONFIG.minEvidenceConfidence) {
    return {
      signal: 'AGUARDAR', trend, confidence: evidence.confidence, streak: evidence.streak,
      slope: evidence.priceChangePercent, dataStatus: 'SUFICIENTES',
      reason: `Evidência dos candles em ${evidence.confidence}%, abaixo do limite de ${CANDLE_ANALYSIS_CONFIG.minEvidenceConfidence}%.${lastCandleNote(evidence)} AGUARDAR.`,
    };
  }

  const signal = evidence.direction > 0 ? 'POSSÍVEL COMPRA' : 'POSSÍVEL VENDA';
  const movement = `${Math.abs(evidence.priceChangePercent).toFixed(3)}%`;
  const breakoutNote = evidence.breakoutDirection === evidence.direction
    ? ' rompimento confirmado na direção'
    : '';
  return {
    signal,
    trend,
    confidence: evidence.confidence,
    streak: evidence.streak,
    slope: evidence.priceChangePercent,
    dataStatus: 'SUFICIENTES',
    reason: `${windowCandles.length} candles fechados: ${alignedLabel}, movimento de ${movement}${breakoutNote}; evidência composta ${evidence.confidence}%.${lastCandleNote(evidence)} Confirmação mede força da evidência, não probabilidade de acerto.`,
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

  timer = scheduler.setTimeout(checkDeadline, Math.max(0, completedAt - scheduler.now()));
  return () => {
    cancelled = true;
    scheduler.clearTimeout(timer);
  };
}
