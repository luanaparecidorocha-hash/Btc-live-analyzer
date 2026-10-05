import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS as WINDOW } from '../lib/analysis.ts';
import { createCrossConfirmedAnalyzer, binanceWindowPoints } from '../lib/crossConfirmation.ts';
import { createAnalysisHistoryStore, decodeAnalysisHistory } from '../lib/analysisHistory.ts';
import { createAnalysisSession } from '../lib/analysisSession.ts';
import { createContinuousCollection } from '../lib/continuousCollection.ts';
import { acquireBinanceMarketFeed, binanceMarketFeed } from '../lib/binanceMarketData.ts';

const START = 1700000000000;
const END = START + WINDOW;
function krakenSeries(move = 0.2, base = 80000) {
  return Array.from({ length: 60 }, (_, i) => ({
    timestamp: START + i * 5000, price: base * (1 + move * i / 60 / 100),
  }));
}
function binanceSnapshot(move = 0.2, base = 80300) {
  const quotes = Array.from({ length: 301 }, (_, i) => ({
    source: 'BINANCE', symbol: 'BTCUSDT', quoteCurrency: 'USDT',
    receivedAt: START - 1000 + i * 1000,
    eventTime: START - 1000 + i * 1000,
    price: base * (1 + move * (i - 1) / 300 / 100),
  }));
  return { status: 'CONECTADO', recentQuotes: quotes, latest: quotes.at(-1), receivedCount: quotes.length, error: null };
}
function evaluate(k, b, now = END) {
  return createCrossConfirmedAnalyzer(analyzeChart, () => b)(k, WINDOW, now);
}
const recordOf = (result) => ({
  timestamp: END, durationMs: WINDOW, signal: result.signal, direction: result.trend,
  confidence: result.confidence, reason: result.reason, crossConfirmation: result.crossConfirmation,
});

for (const [move, direction, signal, confirmation] of [
  [0.2, 'ALTA', 'POSSÍVEL COMPRA', 'ALTA_CONFIRMADA'],
  [-0.2, 'BAIXA', 'POSSÍVEL VENDA', 'BAIXA_CONFIRMADA'],
]) {
  test(`SIMULATED ${direction}/${direction}: strengthens only an already eligible signal`, () => {
    const points = krakenSeries(move);
    const binance = binanceSnapshot(move);
    const original = structuredClone({ points, binance });
    const base = analyzeChart(points, WINDOW, END);
    const result = evaluate(points, binance);
    assert.equal(base.signal, signal);
    assert.equal(result.signal, signal);
    assert.equal(result.crossConfirmation.krakenDirection, direction);
    assert.equal(result.crossConfirmation.binanceDirection, direction);
    assert.equal(result.crossConfirmation.agreement, 'CONCORDANCIA');
    assert.equal(result.crossConfirmation.finalConfirmation, confirmation);
    assert.equal(result.confidence, Math.min(100, base.confidence + 10));
    assert.equal(result.crossConfirmation.finalConfidence, result.confidence);
    assert.equal(result.crossConfirmation.finalSignal, result.signal);
    assert.deepEqual({ points, binance }, original);
    assert.match(result.reason, /não é probabilidade nem garantia/);
  });
}

for (const [krakenMove, binanceMove] of [[0.2, -0.2], [-0.2, 0.2]]) {
  test(`SIMULATED opposite directions ${krakenMove}/${binanceMove}: veto and no bonus`, () => {
    const result = evaluate(krakenSeries(krakenMove), binanceSnapshot(binanceMove));
    assert.equal(result.crossConfirmation.agreement, 'CONFLITO');
    assert.equal(result.signal, 'AGUARDAR');
    assert.equal(result.confidence, 0);
    assert.equal(result.crossConfirmation.confidenceBonus, 0);
    assert.equal(result.crossConfirmation.finalConfirmation, 'SEM_CONFIRMACAO');
  });
}

test('small directional moves cannot bypass current movement criteria on EITHER source', () => {
  for (const [k, b] of [[0.03, 0.03], [0.2, 0.03], [0.03, 0.2]]) {
    const result = evaluate(krakenSeries(k), binanceSnapshot(b));
    assert.equal(result.crossConfirmation.krakenDirection, 'ALTA');
    assert.equal(result.crossConfirmation.binanceDirection, 'ALTA');
    assert.equal(result.crossConfirmation.agreement, 'CONCORDANCIA');
    assert.equal(result.signal, 'AGUARDAR');
    assert.equal(result.crossConfirmation.confidenceBonus, 0);
    assert.equal(result.crossConfirmation.finalConfirmation, 'SEM_CONFIRMACAO');
  }
});

test('lateral movement or a lateral/directional mismatch must wait', () => {
  for (const [k, b] of [[0, 0], [0.2, 0], [0, -0.2]]) {
    assert.equal(evaluate(krakenSeries(k), binanceSnapshot(b)).signal, 'AGUARDAR');
  }
});

test('insufficient, partial, stale, sparse, disconnected and gapped data all fail closed', () => {
  const cases = [];
  cases.push(binanceSnapshot());
  cases[0].recentQuotes = [];
  cases.push({ ...binanceSnapshot(), status: 'RECONECTANDO' });
  cases.push({ ...binanceSnapshot(), status: 'DESATIVADA' });
  cases.push({ ...binanceSnapshot(), recentQuotes: binanceSnapshot().recentQuotes.slice(200) });
  cases.push({ ...binanceSnapshot(), recentQuotes: binanceSnapshot().recentQuotes.slice(0, 240) });
  cases.push({ ...binanceSnapshot(), recentQuotes: binanceSnapshot().recentQuotes.filter((_, i) => i < 60 || i > 100) });
  cases.push({ ...binanceSnapshot(), recentQuotes: binanceSnapshot().recentQuotes.filter((_, i) => i % 30 === 0) });
  cases.push({ ...binanceSnapshot(), recentQuotes: binanceSnapshot().recentQuotes.map((q) => ({ ...q, eventTime: q.eventTime - 20000 })) });
  for (const snapshot of cases) {
    const result = evaluate(krakenSeries(), snapshot);
    assert.equal(result.signal, 'AGUARDAR');
    assert.equal(result.crossConfirmation.agreement, 'DADOS_INSUFICIENTES');
    assert.equal(result.crossConfirmation.binanceDirection, 'INSUFICIENTE');
    assert.equal(result.confidence, 0);
  }
  assert.equal(evaluate([], binanceSnapshot()).signal, 'AGUARDAR');
  assert.equal(evaluate(krakenSeries(), binanceSnapshot(), END - 1).signal, 'AGUARDAR');
});

test('unmodified consistency/path gates veto noisy or reversing Binance even with a net upward move', () => {
  const snapshot = binanceSnapshot();
  snapshot.recentQuotes = snapshot.recentQuotes.map((quote, i) => ({
    ...quote, price: quote.price + (Math.floor(i / 5000 * 1000) % 2 ? 350 : -350),
  }));
  const result = evaluate(krakenSeries(), snapshot);
  assert.equal(result.crossConfirmation.binanceSignal, 'AGUARDAR');
  assert.equal(result.signal, 'AGUARDAR');
  assert.equal(result.crossConfirmation.confidenceBonus, 0);
});

test('confidence is capped at 100, never decreases an eligible baseline or claims a probability', () => {
  const result = evaluate(krakenSeries(0.8), binanceSnapshot(0.8));
  assert.equal(result.signal, 'POSSÍVEL COMPRA');
  assert.equal(result.confidence, 100);
  assert.ok(result.confidence >= result.crossConfirmation.krakenConfidence);
});

test('real predecessor, receipt jitter and exact end boundary: no fabricated or reused samples', () => {
  const snapshot = binanceSnapshot();
  snapshot.recentQuotes = snapshot.recentQuotes.map((q) => ({ ...q, receivedAt: q.receivedAt + 120 }));
  snapshot.recentQuotes.push({ ...snapshot.latest, eventTime: END, receivedAt: END, price: 1 });
  const selected = binanceWindowPoints(snapshot, WINDOW, END);
  assert.equal(selected[0].timestamp, START - 880);
  assert.ok(selected.every((p) => p.timestamp < END));
  assert.ok(selected.every((p) => snapshot.recentQuotes.some((q) => q.receivedAt === p.timestamp && q.price === p.price)));
  assert.equal(evaluate(krakenSeries(), snapshot).signal, 'POSSÍVEL COMPRA');
  const expired = { ...snapshot, recentQuotes: snapshot.recentQuotes.map((q) => ({ ...q, receivedAt: q.receivedAt - 1000000 })) };
  assert.equal(evaluate(krakenSeries(), expired).signal, 'AGUARDAR');
});

test('USD/USDT absolute level differences do not change direction confirmation', () => {
  const a = evaluate(krakenSeries(0.2, 80000), binanceSnapshot(0.2, 81000));
  const b = evaluate(krakenSeries(0.2, 80000), binanceSnapshot(0.2, 70000));
  assert.equal(a.signal, b.signal);
  assert.equal(a.crossConfirmation.agreement, b.crossConfirmation.agreement);
});

test('cross-source results survive save/reload, legacy history is unchanged, corrupt metadata is rejected', async () => {
  let raw = null;
  const storage = { getItem: async () => raw, setItem: async (_, value) => { raw = value; } };
  const result = recordOf(evaluate(krakenSeries(), binanceSnapshot()));
  await createAnalysisHistoryStore(storage).append(result);
  assert.deepEqual(await createAnalysisHistoryStore(storage).load(), [result]);
  const legacy = { ...result };
  delete legacy.crossConfirmation;
  assert.deepEqual(decodeAnalysisHistory(JSON.stringify([legacy])), [legacy]);
  for (const invalid of [null, {}, { ...result.crossConfirmation, finalSignal: 'AGUARDAR' },
    { ...result.crossConfirmation, finalConfidence: 101 },
    { ...result.crossConfirmation, agreement: 'GUARANTEED' }]) {
    assert.throws(() => decodeAnalysisHistory(JSON.stringify([{ ...result, crossConfirmation: invalid }])));
  }
});

test('Android execution owner saves, publishes and notifies FINAL vetoed signal without changing deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const snapshot = binanceSnapshot(-0.2);
  let callbacks;
  let state;
  let raw = null;
  const notifications = [];
  const session = createAnalysisSession({
    windowMs: WINDOW,
    analyze: createCrossConfirmedAnalyzer(analyzeChart, () => snapshot),
    createCollection: createContinuousCollection,
    connect: (next) => { callbacks = next; return { close() {} }; },
    store: createAnalysisHistoryStore({ getItem: async () => raw, setItem: async (_, value) => { raw = value; } }),
    publish: (next) => { state = next; },
    notify: async (record) => { notifications.push(record); },
  });
  t.after(() => session.stop());
  await session.start();
  for (const point of krakenSeries()) {
    t.mock.timers.tick(point.timestamp - Date.now());
    callbacks.onPrice(point);
  }
  assert.equal(state.completedCycle, null);
  t.mock.timers.tick(END - Date.now());
  await session.flush();
  assert.equal(state.completedCycle.timestamp, END);
  assert.equal(state.completedCycle.crossConfirmation.agreement, 'CONFLITO');
  assert.equal(state.completedCycle.signal, 'AGUARDAR');
  assert.equal(decodeAnalysisHistory(raw)[0].signal, 'AGUARDAR');
  assert.equal(notifications[0].signal, 'AGUARDAR');
  assert.equal(state.isRunning, true);
  assert.equal(state.cycleNumber, 2);
  assert.equal(state.history.length, 0);
});

test('UI and Android headless leases share one Binance connection and release independently', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.WebSocket;
  const sockets = [];
  globalThis.WebSocket = class {
    readyState = 1;
    constructor() { sockets.push(this); }
    close() { this.readyState = 3; }
  };
  let releaseUI, releaseHeadless;
  t.after(() => { releaseUI?.(); releaseHeadless?.(); globalThis.WebSocket = original; });
  releaseUI = acquireBinanceMarketFeed();
  releaseHeadless = acquireBinanceMarketFeed();
  assert.equal(sockets.length, 1);
  releaseUI();
  releaseUI(); // Strict-mode/cleanup safe.
  assert.equal(sockets[0].readyState, 1);
  releaseHeadless();
  assert.equal(sockets[0].readyState, 3);
  assert.equal(binanceMarketFeed.getSnapshot().status, 'DESATIVADA');
});

test('foreground completion and Android task both wire the shared wrapper and visible result details', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(source('../context/AnalyzerContext.tsx'), /const result = analyzeCrossConfirmed\(\[\.\.\.points\]/);
  assert.match(source('../lib/registerBackgroundTask.ts'), /analyze: analyzeCrossConfirmed/);
  assert.match(source('../components/AnalysisHistory.tsx'), /CrossConfirmationDetails comparison=\{record.crossConfirmation\}/);
  assert.match(source('../app/index.tsx'), /CrossConfirmationDetails comparison=\{analyzer.completedCycle.crossConfirmation\}/);
});
