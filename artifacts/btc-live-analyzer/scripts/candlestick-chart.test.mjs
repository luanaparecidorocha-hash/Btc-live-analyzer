import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const screen = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
const chart = readFileSync(new URL('../components/CandlestickChart.tsx', import.meta.url), 'utf8');
const context = readFileSync(new URL('../context/AnalyzerContext.tsx', import.meta.url), 'utf8');

test('the screen selects the Kraken or Binance OHLC feed without merging prices', () => {
  assert.match(screen, /chartSource === 'KRAKEN'\s*\? analyzer\.krakenCandles\s*:\s*analyzer\.binanceSnapshot\.recentCandles/);
  assert.match(screen, /binanceWindowCandles\(analyzer\.binanceSnapshot/);
  assert.match(screen, /candles=\{chartCandles\}/);
  assert.match(screen, /currentPrice=\{chartPrice\}/);
});

test('the chart renders candle OHLC rather than sampled-price line data', () => {
  assert.match(chart, /candle\.open/);
  assert.match(chart, /candle\.high/);
  assert.match(chart, /candle\.low/);
  assert.match(chart, /candle\.close/);
  assert.match(chart, /value: 'KRAKEN', label: 'KRAKEN · USD'/);
  assert.match(chart, /value: 'BINANCE', label: 'BINANCE · USDT'/);
  assert.ok(chart.includes('testID={`chart-source-${option.value.toLowerCase()}`}'));
  assert.match(chart, /CANDLES FECHADOS/);
  assert.match(chart, /TENDÊNCIA/);
  assert.match(chart, /CONFIRMAÇÃO/);
  assert.match(chart, /SINAL DA FONTE/);
  assert.doesNotMatch(chart, /Polyline|ChartPoint/);
});

test('the chart observes the existing Binance feed without starting another market connection', () => {
  assert.match(context, /binanceMarketFeed\.subscribe\(syncSnapshot\)/);
  assert.match(context, /binanceMarketFeed\.getSnapshot\(\)/);
  assert.doesNotMatch(context, /new WebSocket/);
});
