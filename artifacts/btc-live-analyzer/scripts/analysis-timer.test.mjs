import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeChart,
  DEFAULT_ANALYSIS_WINDOW_MS,
  scheduleAnalysisDeadline,
} from '../lib/analysis.ts';

class VirtualClock {
  currentTime = 1_000;
  nextId = 0;
  tasks = new Map();

  now = () => this.currentTime;

  setTimeout = (callback, delayMs) => {
    const id = ++this.nextId;
    this.tasks.set(id, {
      dueAt: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

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

function makeLinearPoints(totalChangePercent, count = 60) {
  const lastSampleTimestamp = DEFAULT_ANALYSIS_WINDOW_MS - SAMPLE_INTERVAL_MS;
  return Array.from({ length: count }, (_, index) => {
    const timestamp = count === 60
      ? index * SAMPLE_INTERVAL_MS
      : (index * lastSampleTimestamp) / Math.max(count - 1, 1);
    const progress = timestamp / DEFAULT_ANALYSIS_WINDOW_MS;
    return {
      timestamp,
      price: DEFAULT_PRICE * (1 + (totalChangePercent * progress) / 100),
    };
  });
}

function makeSegmentedPoints(segmentChanges) {
  const segmentDurationMs = DEFAULT_ANALYSIS_WINDOW_MS / segmentChanges.length;
  const segmentStartPrices = [DEFAULT_PRICE];

  for (const changePercent of segmentChanges) {
    const nextPrice = segmentStartPrices[segmentStartPrices.length - 1]
      * (1 + changePercent / 100);
    segmentStartPrices.push(nextPrice);
  }

  return Array.from({ length: 60 }, (_, index) => {
    const timestamp = index * SAMPLE_INTERVAL_MS;
    const segmentIndex = Math.min(
      segmentChanges.length - 1,
      Math.floor(timestamp / segmentDurationMs),
    );
    const segmentStart = segmentIndex * segmentDurationMs;
    const progress = (timestamp - segmentStart) / segmentDurationMs;
    const segmentStartPrice = segmentStartPrices[segmentIndex];
    const price = segmentStartPrice
      * (1 + (segmentChanges[segmentIndex] * progress) / 100);

    return { timestamp, price };
  });
}

test('freezes and evaluates the five-minute window once at exactly 5:00', () => {
  const clock = new VirtualClock();
  const startedAt = clock.now();
  const points = Array.from({ length: 61 }, (_, index) => ({
    timestamp: startedAt + index * 5_000,
    price: 80_000 + index * 10,
  }));
  let completionCount = 0;
  let finalResult = null;

  scheduleAnalysisDeadline(
    startedAt,
    (completedAt) => {
      completionCount += 1;
      finalResult = analyzeChart(points, DEFAULT_ANALYSIS_WINDOW_MS, completedAt);
    },
    clock,
  );

  clock.advanceBy(DEFAULT_ANALYSIS_WINDOW_MS - 1);
  assert.equal(completionCount, 0);
  assert.equal(finalResult, null);
  assert.equal(
    analyzeChart(points.slice(0, -1), DEFAULT_ANALYSIS_WINDOW_MS, clock.now()).signal,
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

test('confirms a sufficiently strong, consistent upward move with a concise explanation', () => {
  const result = analyzeChart(
    makeLinearPoints(0.2),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );

  assert.equal(result.signal, 'POSSÍVEL COMPRA');
  assert.equal(result.trend, 'ALTA');
  assert.ok(result.confidence >= 68);
  assert.match(result.reason, /10\/10 períodos na direção/);
  assert.match(result.reason, /não a chance de acerto/);
});

test('confirms a sufficiently strong, consistent downward move', () => {
  const result = analyzeChart(
    makeLinearPoints(-0.2),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );

  assert.equal(result.signal, 'POSSÍVEL VENDA');
  assert.equal(result.trend, 'BAIXA');
  assert.ok(result.confidence >= 68);
});

test('waits when the net move is too small even if it is consistent', () => {
  const result = analyzeChart(
    makeLinearPoints(0.08),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );

  assert.equal(result.signal, 'AGUARDAR');
  assert.match(result.reason, /abaixo do mínimo de 0\.12%/);
});

test('waits when strong movement conflicts across the analysis window', () => {
  const result = analyzeChart(
    makeSegmentedPoints([0.07, -0.04, 0.07, -0.04, 0.07, -0.04, 0.07, -0.04, 0.07, -0.04]),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );

  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.trend, 'LATERAL');
  assert.match(result.reason, /tendência inconsistente/);
});

test('waits when a completed window has too few or stale samples', () => {
  const sparsePoints = makeLinearPoints(0.3, 8);
  const sparseResult = analyzeChart(
    sparsePoints,
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );
  assert.equal(sparseResult.signal, 'AGUARDAR');
  assert.match(sparseResult.reason, /apenas 8 amostras/);
  assert.ok(sparseResult.confidence < 50);

  const stalePoints = makeLinearPoints(0.3).slice(0, 40);
  const staleResult = analyzeChart(
    stalePoints,
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );
  assert.equal(staleResult.signal, 'AGUARDAR');
  assert.match(staleResult.reason, /cotação mais recente desatualizada/);
  assert.ok(staleResult.confidence < 50);
});

test('waits until the full five-minute window has elapsed', () => {
  const result = analyzeChart(
    makeLinearPoints(0.3),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS - 1,
  );

  assert.equal(result.signal, 'AGUARDAR');
  assert.match(result.reason, /antes de avaliar um sinal/);
});

test('waits on a flat market without mistaking it for insufficient data', () => {
  const result = analyzeChart(makeLinearPoints(0), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS);
  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.trend, 'LATERAL');
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /sem direção clara/);
});

test('waits when the end of the window reverses the overall direction', () => {
  const result = analyzeChart(
    makeSegmentedPoints([0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, 0.08, -0.03, -0.03]),
    DEFAULT_ANALYSIS_WINDOW_MS,
    DEFAULT_ANALYSIS_WINDOW_MS,
  );
  assert.equal(result.signal, 'AGUARDAR');
  assert.match(result.reason, /fim da janela não confirma/);
});

test('a small but predominantly falling or rising five-minute window is directional, not lateral', () => {
  for (const [move, trend] of [[-0.02, 'BAIXA'], [0.02, 'ALTA']]) {
    const result = analyzeChart(makeLinearPoints(move), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS);
    assert.equal(result.trend, trend);
    assert.equal(result.signal, 'AGUARDAR');
    assert.match(result.reason, /abaixo do mínimo/);
  }
});

test('a tiny drift below the noise floor remains lateral', () => {
  const result = analyzeChart(makeLinearPoints(-0.002), DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_ANALYSIS_WINDOW_MS);
  assert.equal(result.trend, 'LATERAL');
  assert.equal(result.signal, 'AGUARDAR');
});
