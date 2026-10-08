// Synthetic fixtures are unit-test-only: no app storage, network or real statistics.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSignalLearningStore, decodeLearningData, emptyLearningData, HORIZONS,
  interruptLearning, LEARNING_KEY, MIN_LEARNING_SAMPLES,
  observeLearningPrice, QUOTE_TOLERANCE_MS, recommendDuration, registerLearningSignal,
} from '../lib/signalLearning.ts';
import { createAnalysisHistoryStore, ANALYSIS_HISTORY_KEY } from '../lib/analysisHistory.ts';
import { cycleNotificationContent } from '../lib/notificationPolicy.ts';

const BUY = 'POSSÍVEL COMPRA';
const SELL = 'POSSÍVEL VENDA';
const record = (timestamp, signal = BUY) => ({
  timestamp, signal, direction: signal === BUY ? 'ALTA' : 'BAIXA',
  confidence: 80, durationMs: 300000, reason: 'Unit-test fixture only',
});
function score(data, timestamp, signal = BUY, prices = [101, 99, 100, 102, 98]) {
  assert.equal(registerLearningSignal(data, record(timestamp, signal)), true);
  assert.equal(observeLearningPrice(data, { timestamp, price: 100 }), true);
  for (const [index, price] of prices.entries()) {
    observeLearningPrice(data, { timestamp: timestamp + (index + 1) * 60000, price });
  }
}
function storage() {
  const values = new Map();
  return {
    values, writes: [],
    getItem: async (key) => values.get(key) ?? null,
    async setItem(key, value) { this.writes.push(key); values.set(key, value); },
  };
}

test('only eligible completed buy/sell signals enter learning; duplicate and stale signals do not', () => {
  const data = emptyLearningData();
  assert.equal(registerLearningSignal(data, record(1000, 'AGUARDAR')), false);
  assert.equal(registerLearningSignal(data, record(NaN)), false);
  assert.equal(registerLearningSignal(data, record(1000)), true);
  assert.equal(registerLearningSignal(data, record(1000)), false);
  assert.equal(registerLearningSignal(data, record(500, SELL)), false);
  assert.equal(data.pending.length, 1);
  assert.equal(data.pending[0].entry, null);
});

test('five future horizons record predicted direction, real observation time, signed variation and outcomes', () => {
  const data = emptyLearningData();
  score(data, 1000);
  const tracked = data.recent[0];
  assert.equal(tracked.predictedDirection, 'ALTA');
  assert.deepEqual(tracked.results.map((r) => r.minutes), HORIZONS);
  assert.deepEqual(tracked.results.map((r) => r.status), ['POSITIVO', 'NEGATIVO', 'NEUTRO', 'POSITIVO', 'NEGATIVO']);
  tracked.results.forEach((r, index) => {
    assert.equal(r.observedAt, 1000 + (index + 1) * 60000);
    assert.ok(Math.abs(r.variationPct - [1, -1, 0, 2, -2][index]) < 1e-10);
  });
  assert.equal(data.stats[BUY].all[2].neutral, 1);
  assert.equal(data.stats[BUY].all[2].positive, 0);
  assert.equal(data.pending.length, 0);
  assert.deepEqual(decodeLearningData(JSON.stringify(data)), data);
});

test('sell success means falling price; statistics and recommendations are separate per direction', () => {
  const data = emptyLearningData();
  score(data, 1000, SELL);
  assert.equal(data.recent[0].predictedDirection, 'BAIXA');
  assert.deepEqual(data.recent[0].results.map((r) => r.status), ['NEGATIVO', 'POSITIVO', 'NEUTRO', 'NEGATIVO', 'POSITIVO']);
  assert.equal(data.stats[BUY].all[0].evaluated, 0);
  assert.equal(data.stats[SELL].all[0].evaluated, 1);
  assert.equal(recommendDuration(data, SELL), null);
});

test('no backfill, interpolation, early price, duplicate quote or async waiting is used', () => {
  const data = emptyLearningData();
  observeLearningPrice(data, { timestamp: 500, price: 99 });
  registerLearningSignal(data, record(1000));
  observeLearningPrice(data, { timestamp: 999, price: 99 });
  assert.equal(data.pending[0].entry, null);
  observeLearningPrice(data, { timestamp: 1005, price: 100 });
  observeLearningPrice(data, { timestamp: 61004, price: 200 });
  assert.equal(data.pending[0].results[0].status, 'PENDENTE');
  assert.equal(observeLearningPrice(data, { timestamp: 61004, price: 1 }), false);
  observeLearningPrice(data, { timestamp: 61005, price: 101 });
  assert.equal(data.pending[0].results[0].status, 'POSITIVO');
  assert.equal(data.pending[0].results[0].observedAt, 61005);
});

test('late entry is missing data; first target quote accepts only the declared 15-second tolerance', () => {
  const data = emptyLearningData();
  registerLearningSignal(data, record(1000));
  observeLearningPrice(data, { timestamp: 1000 + QUOTE_TOLERANCE_MS + 1, price: 100 });
  assert.equal(data.recent[0].entry, null);
  assert.ok(data.recent[0].results.every((r) => r.status === 'SEM_DADOS'));
  const next = 100000;
  registerLearningSignal(data, record(next));
  observeLearningPrice(data, { timestamp: next, price: 100 });
  observeLearningPrice(data, { timestamp: next + 60000 + QUOTE_TOLERANCE_MS, price: 101 });
  assert.equal(data.pending[0].results[0].status, 'POSITIVO');
  observeLearningPrice(data, { timestamp: next + 120000 + QUOTE_TOLERANCE_MS + 1, price: 101 });
  assert.equal(data.pending[0].results[1].status, 'SEM_DADOS');
  assert.equal(data.stats[BUY].all[1].evaluated, 0);
  assert.equal(data.stats[BUY].comparable[0].evaluated, 0);
});

test('stopping or losing the feed keeps evaluated horizons but never invents missing outcomes', () => {
  const data = emptyLearningData();
  registerLearningSignal(data, record(1000));
  observeLearningPrice(data, { timestamp: 1000, price: 100 });
  observeLearningPrice(data, { timestamp: 61000, price: 101 });
  assert.equal(interruptLearning(data), true);
  assert.equal(interruptLearning(data), false);
  assert.equal(data.pending.length, 0);
  assert.deepEqual(data.recent[0].results.map((r) => r.status), ['POSITIVO', ...Array(4).fill('SEM_DADOS')]);
  assert.equal(data.stats[BUY].all[0].evaluated, 1);
  assert.equal(data.stats[BUY].comparable[0].evaluated, 0);
  observeLearningPrice(data, { timestamp: 301000, price: 110 });
  assert.equal(data.stats[BUY].all[4].evaluated, 0);
});

test('minimum 30 complete signals, equal cohort, best hit rate and deterministic shortest tie', () => {
  const data = emptyLearningData();
  for (let i = 0; i < MIN_LEARNING_SAMPLES - 1; i++) {
    score(data, 1000 + i * 360000, BUY, [99, 101, 101, 99, 99]);
  }
  assert.equal(recommendDuration(data, BUY), null);
  score(data, 1000 + (MIN_LEARNING_SAMPLES - 1) * 360000, BUY, [99, 101, 101, 99, 99]);
  assert.deepEqual(recommendDuration(data, BUY), { minutes: 2, hitRate: 100, samples: 30 });
  assert.equal(recommendDuration(data, SELL), null);
  assert.deepEqual(data.stats[BUY].comparable.map((s) => s.evaluated), Array(5).fill(30));
});

test('many partially observed signals cannot qualify a direction for automatic selection', () => {
  const data = emptyLearningData();
  for (let i = 0; i < 40; i++) {
    const time = 1000 + i * 360000;
    registerLearningSignal(data, record(time));
    observeLearningPrice(data, { timestamp: time, price: 100 });
    observeLearningPrice(data, { timestamp: time + 60000, price: 101 });
    interruptLearning(data);
  }
  assert.equal(data.stats[BUY].all[0].evaluated, 40);
  assert.equal(recommendDuration(data, BUY), null);
});

test('recent detail retention does not cap lifetime statistics at 10 or 100', () => {
  const data = emptyLearningData();
  for (let i = 0; i < 105; i++) score(data, 1000 + i * 360000);
  assert.equal(data.recent.length, 100);
  assert.equal(data.stats[BUY].all[0].evaluated, 105);
  assert.equal(data.stats[BUY].comparable[0].evaluated, 105);
  assert.deepEqual(decodeLearningData(JSON.stringify(data)), data);
});

test('shared foreground/headless learning store persists once and survives reload without double scoring', async () => {
  const adapter = storage();
  const store = createSignalLearningStore(adapter);
  assert.equal(createSignalLearningStore(adapter), store);
  await store.load();
  store.register(record(1000));
  store.observe({ timestamp: 1000, price: 100 });
  HORIZONS.forEach((minutes) => store.observe({ timestamp: 1000 + minutes * 60000, price: 101 }));
  store.register(record(1000));
  await store.flush();
  const restoredAdapter = storage();
  restoredAdapter.values.set(LEARNING_KEY, adapter.values.get(LEARNING_KEY));
  const restored = createSignalLearningStore(restoredAdapter);
  await restored.load();
  assert.equal(restored.snapshot().data.stats[BUY].all[0].evaluated, 1);
  assert.deepEqual(restored.snapshot().data, store.snapshot().data);
});

test('process restart marks unobserved pending targets missing instead of scoring a reconnect snapshot', async () => {
  const adapter = storage();
  const first = createSignalLearningStore(adapter);
  await first.load();
  first.register(record(1000));
  first.observe({ timestamp: 1000, price: 100 });
  first.observe({ timestamp: 61000, price: 101 });
  await first.flush();
  const another = storage();
  another.values.set(LEARNING_KEY, adapter.values.get(LEARNING_KEY));
  const restored = createSignalLearningStore(another);
  await restored.load();
  restored.observe({ timestamp: 301000, price: 120 });
  await restored.flush();
  assert.equal(restored.snapshot().data.stats[BUY].all[4].evaluated, 0);
  assert.equal(restored.snapshot().data.pending.length, 0);
});

test('clearing the existing completed history does not erase learning or pending targets', async () => {
  const adapter = storage();
  const store = createSignalLearningStore(adapter);
  await store.load();
  store.register(record(1000));
  store.observe({ timestamp: 1000, price: 100 });
  const history = createAnalysisHistoryStore(adapter);
  await history.append(record(1000));
  await history.clear();
  const before = store.snapshot();
  assert.equal(before.data.pending.length, 1);
  store.observe({ timestamp: 61000, price: 101 });
  await store.flush();
  assert.equal(store.snapshot().data.stats[BUY].all[0].evaluated, 1);
  assert.deepEqual(await history.load(), []);
  assert.equal(adapter.values.get(ANALYSIS_HISTORY_KEY), '[]');
});

test('corrupt persisted learning is explicitly reported and never overwritten', async () => {
  const adapter = storage();
  adapter.values.set(LEARNING_KEY, '{"version":1,"pending":[]}');
  const store = createSignalLearningStore(adapter);
  await assert.rejects(store.load());
  store.register(record(1000));
  store.observe({ timestamp: 1000, price: 100 });
  await store.flush();
  assert.equal(store.snapshot().loaded, false);
  assert.match(store.snapshot().error, /não serão sobrescritos/);
  assert.equal(adapter.writes.length, 0);
});

test('write failure retains session observations, reports failure, and retries on the next change', async () => {
  const adapter = storage();
  const write = adapter.setItem.bind(adapter);
  let fail = true;
  adapter.setItem = async (...args) => { if (fail) throw Error('Unit-test write failure'); await write(...args); };
  const store = createSignalLearningStore(adapter);
  await store.load();
  store.register(record(1000));
  await store.flush();
  assert.match(store.snapshot().error, /não foi possível salvar/i);
  assert.equal(store.recommendation(BUY), null);
  fail = false;
  store.observe({ timestamp: 1000, price: 100 });
  await store.flush();
  assert.equal(store.snapshot().error, null);
  assert.equal(decodeLearningData(adapter.values.get(LEARNING_KEY)).pending[0].entry.price, 100);
});

test('notification distinguishes learned duration, small samples and unmet original criteria', () => {
  const learned = cycleNotificationContent(BUY, 'ALTA', 90, { minutes: 3, hitRate: 76.666, samples: 30 });
  assert.match(learned.title, /POSSÍVEL COMPRA/);
  assert.match(learned.body, /Melhor duração histórica: 3 minutos/);
  assert.match(learned.body, /Taxa de acerto histórica: 76.7%/);
  assert.match(learned.body, /Amostras: 30/);
  assert.match(cycleNotificationContent(SELL, 'BAIXA', 80).body, /ainda está aprendendo/);
  const waiting = cycleNotificationContent('AGUARDAR', 'LATERAL', 20, { minutes: 3, hitRate: 76, samples: 30 });
  assert.match(waiting.title, /AGUARDAR/);
  assert.doesNotMatch(waiting.body, /Melhor duração/);
});
