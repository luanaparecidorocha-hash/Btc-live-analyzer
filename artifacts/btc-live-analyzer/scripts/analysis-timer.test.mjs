import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeCandleFeatures,
  analyzeChart,
  DEFAULT_ANALYSIS_WINDOW_MS,
  selectClosedCandlesInWindow,
  scheduleAnalysisDeadline,
} from '../lib/analysis.ts';
import { readFileSync } from 'node:fs';

class VirtualClock {
  currentTime = 1_000;
  nextId = 0;
  tasks = new Map();
  now = () => this.currentTime;
  setTimeout = (callback, delayMs) => {
    const id = ++this.nextId;
    this.tasks.set(id, { dueAt: this.currentTime + Math.max(0, delayMs), callback });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  advanceBy(durationMs) {
    const targetTime = this.currentTime + durationMs;
    while (true) {
      const dueTask = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= targetTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!dueTask) break;
      const [id, task] = dueTask;
      this.tasks.delete(id);
      this.currentTime = task.dueAt;
      task.callback();
    }
    this.currentTime = targetTime;
  }
}

const SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_PRICE = 80_000;

function makePoints(start = 0, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * SAMPLE_INTERVAL_MS,
    price: DEFAULT_PRICE + index,
  }));
}

/** Explicit OHLC fixtures for isolated engine tests; never used to create live candles. */
function makeCandles(directions, {
  start = 0,
  base = DEFAULT_PRICE,
  stepPercent = 0.02,
  bodyRangeRatio = 0.8,
  upperWickShare = 0.5,
} = {}) {
  let current = base;
  return directions.map((direction, index) => {
    const open = current;
    const change = direction === 'ALTA' ? stepPercent
      : direction === 'BAIXA' ? -stepPercent : 0;
    const close = open * (1 + change / 100);
    const body = Math.abs(close - open);
    const range = body > 0 ? body / bodyRangeRatio : open * 0.001;
    const extraWicks = Math.max(0, range - body);
    const high = Math.max(open, close) + extraWicks * upperWickShare;
    const low = Math.min(open, close) - extraWicks * (1 - upperWickShare);
    current = close;
    return { timestamp: start + index * 60_000, open, high, low, close };
  });
}

function makeLastCountertrendCandles(previousDirection, lastBodyPercent, {
  previousStepPercent = 0.08,
  previousBodyRangeRatio = 0.75,
  previousUpperWickShare = 0.5,
  lastBodyRangeRatio = 0.75,
  trendSideWickShare = (1 - lastBodyRangeRatio) / 2,
} = {}) {
  const priorCandles = makeCandles(Array(4).fill(previousDirection), {
    stepPercent: previousStepPercent,
    bodyRangeRatio: previousBodyRangeRatio,
    upperWickShare: previousUpperWickShare,
  });
  const previous = priorCandles.at(-1);
  const open = previous.close;
  const lastIsBearish = previousDirection === 'ALTA';
  const close = open * (1 + (lastIsBearish ? -1 : 1) * lastBodyPercent / 100);
  const body = Math.abs(close - open);
  const range = body / lastBodyRangeRatio;
  const wickTotal = range - body;
  const trendWick = range * trendSideWickShare;
  const upperWick = lastIsBearish ? wickTotal - trendWick : trendWick;
  const lowerWick = wickTotal - upperWick;
  return [
    ...priorCandles,
    {
      timestamp: priorCandles.at(-1).timestamp + 60_000,
      open,
      high: Math.max(open, close) + upperWick,
      low: Math.min(open, close) - lowerWick,
      close,
    },
  ];
}

test('keeps the analysis deadline at exactly five minutes and completes it once', () => {
  const clock = new VirtualClock();
  const startedAt = clock.now();
  const points = makePoints(startedAt, 61);
  const candles = makeCandles(Array(5).fill('ALTA'), { start: startedAt });
  let completionCount = 0;
  let finalResult = null;

  scheduleAnalysisDeadline(startedAt, (completedAt) => {
    completionCount += 1;
    finalResult = analyzeChart(points, DEFAULT_ANALYSIS_WINDOW_MS, completedAt, candles);
  }, clock);

  clock.advanceBy(DEFAULT_ANALYSIS_WINDOW_MS - 1);
  assert.equal(completionCount, 0);
  assert.equal(finalResult, null);
  assert.equal(
    analyzeChart(points.slice(0, -1), DEFAULT_ANALYSIS_WINDOW_MS, clock.now(), candles).signal,
    'AGUARDAR',
  );
  clock.advanceBy(1);
  assert.equal(clock.now(), startedAt + DEFAULT_ANALYSIS_WINDOW_MS);
  assert.equal(completionCount, 1);
  assert.equal(finalResult.signal, 'POSSÍVEL COMPRA');
  clock.advanceBy(DEFAULT_ANALYSIS_WINDOW_MS);
  assert.equal(completionCount, 1);
  assert.equal(clock.tasks.size, 0);
});

test('extracts the direction, body, range, wicks, body/range ratio and close position', () => {
  const rising = analyzeCandleFeatures({
    timestamp: 0, open: 100, high: 112, low: 98, close: 110,
  });
  assert.equal(rising.direction, 'ALTA');
  assert.equal(rising.bodySize, 10);
  assert.equal(rising.rangeSize, 14);
  assert.equal(rising.upperWick, 2);
  assert.equal(rising.lowerWick, 2);
  assert.ok(Math.abs(rising.bodyRangeRatio - 10 / 14) < 1e-9);
  assert.ok(Math.abs(rising.closePosition - 12 / 14) < 1e-9);

  const falling = analyzeCandleFeatures({
    timestamp: 60_000, open: 110, high: 112, low: 98, close: 100,
  });
  assert.equal(falling.direction, 'BAIXA');
  assert.equal(falling.upperWick, 2);
  assert.equal(falling.lowerWick, 2);
  assert.ok(Math.abs(falling.closePosition - 2 / 14) < 1e-9);

  const neutral = analyzeCandleFeatures({
    timestamp: 120_000, open: 100, high: 102, low: 98, close: 100.1,
  });
  assert.equal(neutral.direction, 'NEUTRA');
  assert.ok(Math.abs(neutral.bodyRangeRatio - 0.1 / 4) < 1e-9);
});

test('relative candle strength is normalized to the provided mean body size', () => {
  const feature = analyzeCandleFeatures({
    timestamp: 0, open: 100, high: 103, low: 99, close: 102,
  }, 4);
  assert.equal(feature.bodyPercent, 2);
  assert.equal(feature.relativeStrength, 0.25);
});

test('a small countertrend final candle is treated as a normal correction in both directions', () => {
  for (const [previousDirection, signal] of [
    ['ALTA', 'POSSÍVEL COMPRA'],
    ['BAIXA', 'POSSÍVEL VENDA'],
  ]) {
    const result = analyzeChart(
      makePoints(),
      DEFAULT_ANALYSIS_WINDOW_MS,
      DEFAULT_ANALYSIS_WINDOW_MS,
      makeLastCountertrendCandles(previousDirection, 0.02),
    );
    assert.equal(result.signal, signal);
    assert.match(result.reason, /correção normal, sem penalidade adicional/);
  }
});

test('a same-sized countertrend final candle reduces confirmation but does not veto the signal', () => {
  for (const [previousDirection, signal] of [
    ['ALTA', 'POSSÍVEL COMPRA'],
    ['BAIXA', 'POSSÍVEL VENDA'],
  ]) {
    const moderate = analyzeChart(
      makePoints(),
      DEFAULT_ANALYSIS_WINDOW_MS,
      DEFAULT_ANALYSIS_WINDOW_MS,
      makeLastCountertrendCandles(previousDirection, 0.08),
    );
    const rejectedCorrection = analyzeChart(
      makePoints(),
      DEFAULT_ANALYSIS_WINDOW_MS,
      DEFAULT_ANALYSIS_WINDOW_MS,
      makeLastCountertrendCandles(previousDirection, 0.08, {
        lastBodyRangeRatio: 0.55,
        trendSideWickShare: 0.35,
      }),
    );
    assert.equal(moderate.signal, signal);
    assert.match(moderate.reason, /reduziu 4 pontos por perda de força/);
    assert.equal(rejectedCorrection.signal, signal);
    assert.match(rejectedCorrection.reason, /correção normal, sem penalidade adicional/);
    assert.equal(rejectedCorrection.confidence, moderate.confidence + 4);
  }
});

test('a strong countertrend candle with close-at-extreme and erased movement waits as a possible reversal', () => {
  for (const previousDirection of ['ALTA', 'BAIXA']) {
    const result = analyzeChart(
      makePoints(),
      DEFAULT_ANALYSIS_WINDOW_MS,
      DEFAULT_ANALYSIS_WINDOW_MS,
      makeLastCountertrendCandles(previousDirection, 0.2),
    );
    assert.equal(result.signal, 'AGUARDAR');
    assert.match(result.reason, /último candle contrário forte.*possível reversão/i);
    assert.ok(result.confidence <= 68);
  }
});

test('a strong isolated countertrend candle does not veto a clearly intact trend', () => {
  const candles = makeLastCountertrendCandles('ALTA', 0.3, {
    previousStepPercent: 0.2,
    previousBodyRangeRatio: 0.66,
    previousUpperWickShare: 0,
  });
  const result = analyzeChart(
    makePoints(),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
    candles,
  );
  assert.equal(result.signal, 'POSSÍVEL COMPRA');
  assert.match(result.reason, /reduziu 4 pontos por perda de força/);
  assert.doesNotMatch(result.reason, /possível reversão/);
});

test('five coherent rising or falling candles can signal without a hard 0.12% gate', () => {
  for (const [direction, expected, trend] of [
    ['ALTA', 'POSSÍVEL COMPRA', 'ALTA'],
    ['BAIXA', 'POSSÍVEL VENDA', 'BAIXA'],
  ]) {
    const result = analyzeChart(
      makePoints(),
      DEFAULT_ANALYSIS_WINDOW_MS,
      DEFAULT_ANALYSIS_WINDOW_MS,
      makeCandles(Array(5).fill(direction)),
    );
    assert.equal(result.signal, expected);
    assert.equal(result.trend, trend);
    assert.ok(result.confidence >= 68);
    assert.ok(Math.abs(result.slope) < 0.12);
    assert.match(result.reason, /não probabilidade de acerto/);
  }
});

test('alternating directions and a market of doji candles remain AGUARDAR', () => {
  const alternating = analyzeChart(
    makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS,
    makeCandles(['ALTA', 'BAIXA', 'ALTA', 'BAIXA', 'ALTA'], { stepPercent: 0.08 }),
  );
  assert.equal(alternating.signal, 'AGUARDAR');
  assert.match(alternating.reason, /Sequência indecisa|tendência estável/);

  const sideways = analyzeChart(
    makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS,
    makeCandles(Array(5).fill('NEUTRA')),
  );
  assert.equal(sideways.signal, 'AGUARDAR');
  assert.equal(sideways.trend, 'LATERAL');
});

test('two strong late candles against the earlier sequence identify possible reversal', () => {
  const result = analyzeChart(
    makePoints(),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
    makeCandles(['ALTA', 'ALTA', 'ALTA', 'BAIXA', 'BAIXA'], { stepPercent: 0.06 }),
  );
  assert.equal(result.signal, 'AGUARDAR');
  assert.match(result.reason, /possível reversão/);
});

test('closed candles only: insufficient OHLC and a not-yet-closed candle cannot form a final signal', () => {
  const result = analyzeChart(
    makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS,
    makeCandles(['ALTA', 'ALTA']),
  );
  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.dataStatus, 'INSUFICIENTES');
  assert.match(result.reason, /candles de 1 minuto fechados/);

  const openAtDeadline = {
    timestamp: 240_001,
    open: 80_000,
    high: 80_200,
    low: 79_900,
    close: 80_200,
  };
  const excluded = analyzeChart(
    makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS,
    [...makeCandles(['ALTA', 'ALTA']), openAtDeadline],
  );
  assert.equal(excluded.signal, 'AGUARDAR');
  assert.equal(excluded.dataStatus, 'INSUFICIENTES');
});

test('the chart window selector preserves real OHLC objects and excludes the open minute', () => {
  const first = { timestamp: 0, open: 100, high: 103, low: 99, close: 102 };
  const originalMinute = { timestamp: 60_000, open: 102, high: 105, low: 101, close: 104 };
  const replacementMinute = { timestamp: 60_000, open: 102, high: 106, low: 101, close: 105 };
  const third = { timestamp: 120_000, open: 105, high: 107, low: 104, close: 106 };
  const stillOpen = { timestamp: 180_000, open: 106, high: 108, low: 105, close: 107 };
  const selected = selectClosedCandlesInWindow(
    [first, originalMinute, third, stillOpen, replacementMinute],
    0,
    180_000,
  );
  assert.deepEqual(selected, [first, replacementMinute, third]);
  assert.equal(selected[0], first, 'the chart must reuse the real candle object, not synthesize OHLC');
  assert.equal(selected[1], replacementMinute, 'latest update for a minute replaces the older real update');
  assert.ok(selected.every((candle) => candle.timestamp + 60_000 <= 180_000));

  const chartSource = readFileSync(new URL('../components/CandlestickChart.tsx', import.meta.url), 'utf8');
  assert.match(chartSource, /candles\.map\(\(candle, index\)/);
  assert.match(chartSource, /candle\.open/);
  assert.match(chartSource, /candle\.high/);
  assert.match(chartSource, /candle\.low/);
  assert.match(chartSource, /candle\.close/);
});

test('gapped minute data fails closed instead of treating sparse candles as a sequence', () => {
  const source = makeCandles(['ALTA', 'ALTA', 'ALTA']);
  const result = analyzeChart(
    makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS,
    [source[0], source[1], { ...source[2], timestamp: 181_000 }],
  );
  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.dataStatus, 'INSUFICIENTES');
  assert.match(result.reason, /lacuna de candles/);
});

test('stale live quote data fails closed even if stored candles are present', () => {
  const result = analyzeChart(
    makePoints(0, 40),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
    makeCandles(Array(5).fill('ALTA')),
  );
  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.dataStatus, 'INSUFICIENTES');
  assert.match(result.reason, /Cotação da fonte desatualizada/);
});

test('conflicting price movement and candle direction does not produce a signal', () => {
  const candles = makeCandles(['ALTA', 'ALTA', 'BAIXA', 'BAIXA', 'BAIXA'], { stepPercent: 0.03 });
  const result = analyzeChart(makePoints(), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS, candles);
  assert.equal(result.signal, 'AGUARDAR');
});

test('a confirmed close beyond the previous five-candle range is reported as a breakout', () => {
  const start = 600_000;
  const previous = Array.from({ length: 5 }, (_, index) => ({
    timestamp: 300_000 + index * 60_000,
    open: 100, high: 101, low: 99, close: 100,
  }));
  const current = makeCandles(Array(5).fill('ALTA'), {
    start, base: 100, stepPercent: 0.3, bodyRangeRatio: 0.9,
  });
  const result = analyzeChart(
    makePoints(start),
    DEFAULT_ANALYSIS_WINDOW_MS,
    start + DEFAULT_ANALYSIS_WINDOW_MS,
    [...previous, ...current],
  );
  assert.equal(result.signal, 'POSSÍVEL COMPRA');
  assert.match(result.reason, /rompimento confirmado/);
});
