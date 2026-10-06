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

test('history always retains only the ten newest completed analyses, including after reload', async () => {
  const storage = memoryStorage();
  const store = createAnalysisHistoryStore(storage);
  for (let index = 0; index < 105; index += 1) await store.append(record(index));
  const results = await createAnalysisHistoryStore({ getItem: storage.getItem, setItem: storage.setItem }).load();
  assert.equal(results.length, 10);
  assert.deepEqual(results.map((item) => item.timestamp), Array.from({ length: 10 }, (_, i) => i + 95));
  assert.equal(JSON.parse(storage.values.get(ANALYSIS_HISTORY_KEY)).length, 10);
});

test('the eleventh completion removes only the oldest, even with out-of-order input', async () => {
  const storage = memoryStorage();
  const store = createAnalysisHistoryStore(storage);
  for (let i = 1; i <= 10; i++) await store.append(record(i));
  assert.deepEqual(await store.append(record(11)), Array.from({ length: 10 }, (_, i) => record(i + 2)));
  assert.deepEqual(await store.append(record(0)), Array.from({ length: 10 }, (_, i) => record(i + 2)));
});

test('loading legacy histories larger than ten keeps and persists the ten newest without changing data', async () => {
  const storage = memoryStorage();
  const saved = Array.from({ length: 15 }, (_, i) => record(i)).reverse();
  storage.values.set(ANALYSIS_HISTORY_KEY, JSON.stringify(saved));
  assert.deepEqual(await createAnalysisHistoryStore(storage).load(), saved.reverse().slice(-10));
  assert.deepEqual(JSON.parse(storage.values.get(ANALYSIS_HISTORY_KEY)), saved.slice(-10));
});

test('UI and background share a store and clear cannot resurrect earlier queued completions', async () => {
  const storage = memoryStorage();
  const ui = createAnalysisHistoryStore(storage);
  const background = createAnalysisHistoryStore(storage);
  assert.equal(ui, background);
  const changes = [];
  const unsubscribe = background.subscribe((records) => changes.push(records));
  const before = background.append(record(1));
  const clear = ui.clear();
  const after = background.append(record(2));
  await Promise.all([before, clear, after]);
  assert.deepEqual(await ui.load(), [record(2)]);
  assert.deepEqual(JSON.parse(storage.values.get(ANALYSIS_HISTORY_KEY)), [record(2)]);
  assert.ok(changes.some((records) => records.length === 0));
  unsubscribe();
  await ui.clear();
  assert.deepEqual(await createAnalysisHistoryStore({ getItem: storage.getItem, setItem: storage.setItem }).load(), []);
});

test('a failed deletion preserves both displayed and saved records', async () => {
  const storage = memoryStorage();
  const store = createAnalysisHistoryStore(storage);
  await store.append(record(1));
  const write = storage.setItem;
  storage.setItem = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(store.clear(), /disk unavailable/);
  assert.deepEqual(await store.load(), [record(1)]);
  assert.deepEqual(JSON.parse(storage.values.get(ANALYSIS_HISTORY_KEY)), [record(1)]);
  storage.setItem = write;
  await store.clear();
  assert.deepEqual(await store.load(), []);
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