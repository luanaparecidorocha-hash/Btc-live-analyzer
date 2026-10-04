import assert from 'node:assert/strict';
import test from 'node:test';
import { createContinuousCollection } from '../lib/continuousCollection.ts';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from '../lib/analysis.ts';
import { createAnalysisHistoryStore } from '../lib/analysisHistory.ts';

class Clock {
  time = 1000;
  nextId = 0;
  tasks = new Map();
  maximumTimers = 0;
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.tasks.set(id, { callback, due: this.time + delay });
    this.maximumTimers = Math.max(this.maximumTimers, this.tasks.size);
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  advanceTo(time) {
    while (true) {
      const due = [...this.tasks].filter(([, task]) => task.due <= time)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.time = due[1].due;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
    this.time = time;
  }
}

function setup() {
  const clock = new Clock();
  const completed = [];
  let state;
  const collector = createContinuousCollection({
    windowMs: DEFAULT_ANALYSIS_WINDOW_MS,
    onUpdate: (next) => { state = next; },
    onComplete: (points, completedAt) => {
      completed.push({ points, completedAt, result: analyzeChart([...points], DEFAULT_ANALYSIS_WINDOW_MS, completedAt) });
    },
  }, clock);
  return { clock, collector, completed, state: () => state };
}

function feedCycle(subject, start, change = 0.2) {
  for (let index = 0; index < 60; index += 1) {
    const timestamp = start + index * 5000;
    subject.clock.advanceTo(timestamp);
    subject.collector.push({ timestamp, price: 80_000 * (1 + change * (index / 60) / 100) });
  }
}

test('one start completes two exact five-minute cycles, using only one timer and preserving frozen first data', () => {
  const subject = setup();
  subject.collector.start();
  subject.collector.start(); // double-start is idempotent
  assert.equal(subject.clock.tasks.size, 0, 'no countdown before the first live quote');
  feedCycle(subject, 1000);
  subject.clock.advanceTo(300999);
  assert.equal(subject.completed.length, 0);
  subject.clock.advanceTo(301000);
  assert.equal(subject.completed.length, 1);
  assert.equal(subject.collector.isRunning(), true);
  assert.equal(subject.state().cycleNumber, 2);
  assert.equal(subject.state().startedAt, null, 'next cycle waits for a NEW live quote');
  assert.equal(subject.state().points.length, 0);
  const first = structuredClone(subject.completed[0]);
  assert.equal(first.result.signal, 'POSSÍVEL COMPRA');
  assert.ok(Object.isFrozen(subject.completed[0].points));
  feedCycle(subject, 301000, -0.2);
  subject.clock.advanceTo(601000);
  assert.equal(subject.completed.length, 2);
  assert.equal(subject.completed[1].result.signal, 'POSSÍVEL VENDA');
  assert.deepEqual(subject.completed[0], first);
  assert.equal(subject.clock.maximumTimers, 1);
  subject.collector.stop();
  assert.equal(subject.clock.tasks.size, 0);
});

test('a boundary quote starts the new cycle and never leaks into the completed window', () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000);
  // Deadline timer already fired at the boundary; push still must not duplicate.
  subject.clock.advanceTo(301000);
  subject.collector.push({ timestamp: 301000, price: 90000 });
  assert.equal(subject.completed.length, 1);
  assert.ok(subject.completed[0].points.every((point) => point.timestamp < 301000));
  assert.equal(subject.state().points[0].price, 90000);
});

test('a delayed first quote anchors a full second window without fabricating or reusing quotes', () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000);
  subject.clock.advanceTo(301000);
  subject.clock.advanceTo(308000);
  assert.equal(subject.completed.length, 1);
  assert.equal(subject.clock.tasks.size, 0);
  feedCycle(subject, 308000, -0.2);
  subject.clock.advanceTo(607999);
  assert.equal(subject.completed.length, 1);
  subject.clock.advanceTo(608000);
  assert.equal(subject.completed.length, 2);
  assert.equal(subject.completed[1].points[0].timestamp, 308000);
  assert.equal(subject.completed[1].completedAt, 608000);
  assert.equal(subject.completed[1].result.signal, 'POSSÍVEL VENDA');
  subject.collector.stop();
});

test('PARAR cancels all collection callbacks, rejects later quotes and never saves a partial cycle', () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000);
  subject.clock.advanceTo(301000);
  subject.collector.push({ timestamp: 301000, price: 80000 });
  subject.collector.stop();
  subject.clock.advanceTo(1_000_000);
  subject.collector.push({ timestamp: 1_000_000, price: 90000 });
  assert.equal(subject.completed.length, 1);
  assert.equal(subject.clock.tasks.size, 0);
  assert.equal(subject.collector.isRunning(), false);
  assert.equal(subject.state().points.length, 0);
});

test('safe reconnection abandons only an incomplete cycle and resumes from a new first quote', () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000);
  subject.clock.advanceTo(301000);
  subject.collector.push({ timestamp: 301000, price: 80000 });
  subject.collector.reconnect();
  subject.collector.reconnect();
  subject.clock.advanceTo(700000);
  assert.equal(subject.completed.length, 1);
  assert.equal(subject.clock.tasks.size, 0);
  feedCycle(subject, 700000, -0.2);
  subject.clock.advanceTo(1000000);
  assert.equal(subject.completed.length, 2);
  assert.equal(subject.completed[1].completedAt, 1000000);
  assert.equal(subject.clock.maximumTimers, 1);
  subject.collector.stop();
});

test('AGUARDAR cycles still complete and continue, without weakening the real decision engine', () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000, 0);
  subject.clock.advanceTo(301000);
  assert.equal(subject.completed[0].result.trend, 'LATERAL');
  assert.equal(subject.completed[0].result.signal, 'AGUARDAR');
  assert.equal(subject.state().cycleNumber, 2);
  subject.collector.stop();
});

test('both completed cycles persist in the existing history storage after reopening', async () => {
  const subject = setup();
  subject.collector.start();
  feedCycle(subject, 1000);
  subject.clock.advanceTo(301000);
  feedCycle(subject, 301000, -0.2);
  subject.clock.advanceTo(601000);
  subject.collector.stop();
  let saved = null;
  const storage = { getItem: async () => saved, setItem: async (_, value) => { saved = value; } };
  const store = createAnalysisHistoryStore(storage);
  for (const cycle of subject.completed) {
    await store.append({
      timestamp: cycle.completedAt, signal: cycle.result.signal,
      direction: cycle.result.trend, confidence: cycle.result.confidence,
      durationMs: DEFAULT_ANALYSIS_WINDOW_MS, reason: cycle.result.reason,
    });
  }
  const restored = await createAnalysisHistoryStore(storage).load();
  assert.equal(restored.length, 2);
  assert.equal(restored[0].signal, 'POSSÍVEL COMPRA');
  assert.equal(restored[1].signal, 'POSSÍVEL VENDA');
  assert.ok(restored.every((record) => record.durationMs === 300000));
});