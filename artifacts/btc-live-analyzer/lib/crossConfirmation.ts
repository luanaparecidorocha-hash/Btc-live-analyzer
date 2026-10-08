import type { AnalysisResult, ChartPoint, OhlcCandle, Signal } from './analysis';
import type { BinanceFeedSnapshot } from './binanceMarketData';

export type SourceDirection = AnalysisResult['trend'] | 'INSUFICIENTE';
export type CrossConfirmation = Readonly<{
  krakenDirection: SourceDirection;
  binanceDirection: SourceDirection;
  agreement: 'CONCORDANCIA' | 'CONFLITO' | 'NEUTRO' | 'DADOS_INSUFICIENTES';
  finalConfirmation: 'ALTA_CONFIRMADA' | 'BAIXA_CONFIRMADA' | 'SEM_CONFIRMACAO';
  finalSignal: Signal;
  finalConfidence: number;
  krakenSignal: Signal;
  binanceSignal: Signal;
  krakenConfidence: number;
  binanceConfidence: number;
  confidenceBonus: number;
  windowStart: number;
  windowEnd: number;
}>;

type Engine = (
  points: ChartPoint[],
  windowMs: number,
  now: number,
  candles?: readonly OhlcCandle[],
) => AnalysisResult;
const CONFIRMATION_BONUS = 10;
const SAMPLE_MS = 5_000;
const SOURCE_TIME_TOLERANCE_MS = 15_000;
const CANDLE_HISTORY_LOOKBACK_MS = 5 * 60 * 1000;

/** Actual observations only, same receipt clock/window and 5s sampling as Kraken.
 * One real observation immediately BEFORE the window is retained for the existing
 * elapsed-time gate. The engine itself excludes it from movement calculations.
 * Never fabricate a boundary price, interpolate prices, or compare USD to USDT.
 */
export function binanceWindowPoints(snapshot: BinanceFeedSnapshot, windowMs: number, now: number): ChartPoint[] {
  if (snapshot.status !== 'CONECTADO') return [];
  const start = now - windowMs;
  const candidates = snapshot.recentQuotes.filter((quote) => (
    quote.source === 'BINANCE' && quote.symbol === 'BTCUSDT' && quote.quoteCurrency === 'USDT'
    && quote.receivedAt >= start - SOURCE_TIME_TOLERANCE_MS && quote.receivedAt < now
    && Math.abs(quote.receivedAt - quote.eventTime) <= SOURCE_TIME_TOLERANCE_MS
  )).sort((a, b) => a.receivedAt - b.receivedAt);
  const predecessor = candidates.filter((quote) => quote.receivedAt < start).at(-1);
  const points: ChartPoint[] = predecessor
    ? [{ timestamp: predecessor.receivedAt, price: predecessor.price }] : [];
  let lastSample: number | null = null;
  for (const quote of candidates) {
    if (quote.receivedAt < start) continue;
    if (lastSample === null || quote.receivedAt - lastSample >= SAMPLE_MS) {
      points.push({ timestamp: quote.receivedAt, price: quote.price });
      lastSample = quote.receivedAt;
    }
  }
  return points;
}

/** Return only real, already-closed Binance candles near the active window. */
export function binanceWindowCandles(
  snapshot: BinanceFeedSnapshot,
  windowMs: number,
  now: number,
): OhlcCandle[] {
  if (snapshot.status !== 'CONECTADO') return [];
  const earliest = now - windowMs - CANDLE_HISTORY_LOOKBACK_MS;
  return (snapshot.recentCandles ?? []).filter((candle) => (
    candle.timestamp >= earliest
    && candle.timestamp + 60_000 <= now
  ));
}

/** Apply the same candle-evidence engine independently to each exchange.
 * Cross-source corroboration can strengthen only signals already eligible
 * on both feeds; it cannot override a source veto or manufacture a direction.
 */
export function createCrossConfirmedAnalyzer(engine: Engine, getBinance: () => BinanceFeedSnapshot): Engine {
  return (points, windowMs, now, krakenCandles = []) => {
    const snapshot = getBinance();
    const kraken = engine(points, windowMs, now, krakenCandles);
    const binance = engine(
      binanceWindowPoints(snapshot, windowMs, now),
      windowMs,
      now,
      binanceWindowCandles(snapshot, windowMs, now),
    );
    const krakenDirection: SourceDirection = kraken.dataStatus === 'SUFICIENTES' ? kraken.trend : 'INSUFICIENTE';
    const binanceDirection: SourceDirection = binance.dataStatus === 'SUFICIENTES' ? binance.trend : 'INSUFICIENTE';
    const insufficient = krakenDirection === 'INSUFICIENTE' || binanceDirection === 'INSUFICIENTE';
    const conflict = (krakenDirection === 'ALTA' && binanceDirection === 'BAIXA')
      || (krakenDirection === 'BAIXA' && binanceDirection === 'ALTA');
    const agreed = !insufficient && krakenDirection === binanceDirection;
    const eligible = agreed && krakenDirection !== 'LATERAL'
      && kraken.signal !== 'AGUARDAR' && kraken.signal === binance.signal;
    const signal: Signal = eligible ? kraken.signal : 'AGUARDAR';
    const confidence = eligible
      ? Math.min(100, kraken.confidence + CONFIRMATION_BONUS)
      : insufficient || conflict ? 0 : Math.min(kraken.confidence, binance.confidence);
    const crossConfirmation: CrossConfirmation = Object.freeze({
      krakenDirection, binanceDirection,
      agreement: insufficient ? 'DADOS_INSUFICIENTES' : conflict ? 'CONFLITO' : agreed ? 'CONCORDANCIA' : 'NEUTRO',
      finalConfirmation: eligible
        ? krakenDirection === 'ALTA' ? 'ALTA_CONFIRMADA' : 'BAIXA_CONFIRMADA'
        : 'SEM_CONFIRMACAO',
      finalSignal: signal, finalConfidence: confidence,
      krakenSignal: kraken.signal, binanceSignal: binance.signal,
      krakenConfidence: kraken.confidence, binanceConfidence: binance.confidence,
      confidenceBonus: eligible ? confidence - kraken.confidence : 0,
      windowStart: now - windowMs, windowEnd: now,
    });
    const explanation = insufficient
      ? 'Dados insuficientes em pelo menos uma fonte; AGUARDAR.'
      : conflict ? 'Conflito entre Kraken e Binance; AGUARDAR.'
      : eligible ? `Direção confirmada pelas duas fontes; +${crossConfirmation.confidenceBonus} pontos de força.`
      : 'Sem confirmação elegível: pelo menos uma fonte não atende aos critérios atuais; AGUARDAR.';
    return {
      ...kraken, signal, confidence, crossConfirmation,
      reason: `${kraken.reason} Kraken BTC/USD: ${krakenDirection}; Binance BTC/USDT: ${binanceDirection}. ${explanation} Concordância adicional não é probabilidade nem garantia de acerto.`,
    };
  };
}
