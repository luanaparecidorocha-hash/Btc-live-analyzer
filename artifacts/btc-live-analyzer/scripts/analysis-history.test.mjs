import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYSIS_HISTORY_KEY,
  createAnalysisHistoryStore,
  decodeAnalysisHistory,
  mergeAnalysisHistory,
} from '../lib/analysisHistory.ts';

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
  };
}
const record = (timestamp, signal = 'AGUARDAR') => ({
  timestamp,
  signal,
  direction: 'BAIXA',
  confidence: 48,
  durationMs: 300_000,
  reason: 'Movimento descendente, mas sem força suficiente para emitir um sinal.',
});

test('a second completed analysis preserves the first, including after reload', async () => {
  const storage = memoryStorage();
  const store = createAnalysisHistoryStore(storage);
  const first = record(300_000);
  const second = record(700_000, 'POSSÍVEL VENDA');
  await store.append(first);
  const results = await store.append(second);
  assert.deepEqual(results, [first, second]);
  assert.deepEqual(await createAnalysisHistoryStore(storage).load(), [first, second]);
});

test('hydration and concurrent completions merge rather than overwrite history', async () => {
  const storage = memoryStorage();
  storage.values.set(ANALYSIS_HISTORY_KEY, JSON.stringify([record(100)]));
  const store = createAnalysisHistoryStore(storage);
  const [loaded, appended, second] = await Promise.all([
    store.load(), store.append(record(200)), store.append(record(300)),
  ]);
  assert.equal(loaded.length, 1);
  assert.equal(appended.length, 2);
  assert.equal(second.length, 3);
  assert.deepEqual(mergeAnalysisHistory(loaded, second), second);
});

test('history is not truncated after one hundred completed analyses', async () => {
  const storage = memoryStorage();
  const store = createAnalysisHistoryStore(storage);
  for (let index = 0; index < 105; index += 1) await store.append(record(index));
  const results = await createAnalysisHistoryStore(storage).load();
  assert.equal(results.length, 105);
  assert.equal(results[0].timestamp, 0);
});

test('older saved records are preserved without inventing their duration', () => {
  const legacy = record(100);
  delete legacy.durationMs;
  const decoded = decodeAnalysisHistory(JSON.stringify([legacy]));
  assert.equal(decoded[0].durationMs, null);
  assert.equal(decoded[0].reason, legacy.reason);
});

test('a failed write is explicit and the next successful save retains both results', async () => {
  const storage = memoryStorage();
  const write = storage.setItem;
  let fail = true;
  storage.setItem = async (key, value) => {
    if (fail) { fail = false; throw new Error('disk unavailable'); }
    return write(key, value);
  };
  const store = createAnalysisHistoryStore(storage);
  await assert.rejects(store.append(record(100)), /disk unavailable/);
  await store.append(record(200));
  assert.equal((await createAnalysisHistoryStore(storage).load()).length, 2);
});

test('corrupt persisted history is not silently replaced', async () => {
  const storage = memoryStorage();
  storage.values.set(ANALYSIS_HISTORY_KEY, 'invalid json');
  const store = createAnalysisHistoryStore(storage);
  await assert.rejects(store.append(record(100)));
  assert.equal(storage.values.get(ANALYSIS_HISTORY_KEY), 'invalid json');
});