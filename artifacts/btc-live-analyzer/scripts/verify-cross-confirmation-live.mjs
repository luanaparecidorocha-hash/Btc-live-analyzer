// Reads actual public streams for >=5 minutes. No app storage, orders, credentials,
// simulated quotes or shortened engine windows. Output is development evidence.
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from '../lib/analysis.ts';
import { connectBtcUsdTicker } from '../lib/marketData.ts';
import { createBinanceMarketFeed } from '../lib/binanceMarketData.ts';
import { createCrossConfirmedAnalyzer, binanceWindowCandles, binanceWindowPoints } from '../lib/crossConfirmation.ts';

const binance = createBinanceMarketFeed();
const analyze = createCrossConfirmedAnalyzer(analyzeChart, binance.getSnapshot);
const points = [];
const candles = [];
let kraken;
let start;
let timer;
let checking;
let unsubscribe;
const errors = [];
try {
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(`Live verification timeout: ${errors.join('; ')}`)), 430000);
    const check = () => {
      if (!start || Date.now() < start + DEFAULT_ANALYSIS_WINDOW_MS) return;
      const now = Date.now();
      const evaluated = analyze(points, DEFAULT_ANALYSIS_WINDOW_MS, now, candles);
      const cross = evaluated.crossConfirmation;
      if (cross.krakenDirection === 'INSUFICIENTE' || cross.binanceDirection === 'INSUFICIENTE') return;
      // Prefer a genuine directional agreement. A real lateral agreement is kept
      // as a fallback, never described as a confirmed buy/sell.
      if (cross.agreement === 'CONCORDANCIA' && (cross.krakenDirection !== 'LATERAL' || now - start > 390000)) {
        resolve({
          observedAt: new Date(now).toISOString(),
          evaluated, krakenPoints: points, krakenCandles: candles,
          binancePoints: binanceWindowPoints(binance.getSnapshot(), DEFAULT_ANALYSIS_WINDOW_MS, now),
          binanceCandles: binanceWindowCandles(binance.getSnapshot(), DEFAULT_ANALYSIS_WINDOW_MS, now),
          binanceQuotes: binance.getSnapshot().recentQuotes,
          errors,
        });
      }
    };
    checking = setInterval(check, 1000);
    unsubscribe = binance.subscribe(() => {
      if (kraken || binance.getSnapshot().receivedCount < 3) return;
      kraken = connectBtcUsdTicker({
        onPrice: (point) => {
          if (!start) start = point.timestamp;
          const last = points.at(-1);
          if (!last || point.timestamp - last.timestamp >= 5000) points.push(point);
        },
        onCandle: (candle) => {
          const index = candles.findIndex((item) => item.timestamp === candle.timestamp);
          if (index >= 0) candles[index] = candle;
          else candles.push(candle);
          candles.sort((left, right) => left.timestamp - right.timestamp);
          if (candles.length > 60) candles.splice(0, candles.length - 60);
        },
        onStatus: (status) => {
          if (status === 'RECONECTANDO') { points.length = 0; candles.length = 0; start = null; }
        },
        onError: (message) => errors.push(message),
      });
    });
    binance.start();
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearTimeout(timer);
  clearInterval(checking);
  unsubscribe?.();
  kraken?.close();
  binance.stop();
}
