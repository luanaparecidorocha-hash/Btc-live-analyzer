import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisSession } from '../lib/analysisSession.ts';
import { createContinuousCollection } from '../lib/continuousCollection.ts';
import { analyzeChart, DEFAULT_ANALYSIS_WINDOW_MS } from '../lib/analysis.ts';
import { createAnalysisHistoryStore } from '../lib/analysisHistory.ts';
import { cycleNotificationContent, requestNotificationPermission } from '../lib/notificationPolicy.ts';
import { createSignalLearningStore } from '../lib/signalLearning.ts';

class Clock {
  time = 1000;
  id = 0;
  tasks = new Map();
  maxTimers = 0;
  now = () => this.time;
  clearTimeout = (id) => this.tasks.delete(id);
  setTimeout = (callback, delay) => {
    const id = ++this.id;
    this.tasks.set(id, { callback, due: this.time + delay });
    this.maxTimers = Math.max(this.maxTimers, this.tasks.size);
    return id;
  };
  advanceTo(time) {
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.due <= time).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      this.time = next[1].due;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.time = time;
  }
}

function setup({ notifyError = false, deferredWrite = null, deferredNotify = null, learning = undefined } = {}) {
  const clock = new Clock();
  let data = null;
  let callbacks;
  let snapshot;
  let connections = 0;
  let closes = 0;
  const notifications = [];
  const order = [];
  const storage = {
    getItem: async () => data,
    setItem: async (_, value) => {
      if (deferredWrite) await deferredWrite;
      data = value;
      order.push('save');
    },
  };
  const session = createAnalysisSession({
    windowMs: DEFAULT_ANALYSIS_WINDOW_MS,
    analyze: analyzeChart,
    createCollection: (options) => createContinuousCollection(options, clock),
    store: createAnalysisHistoryStore(storage),
    learning,
    connect: (next) => { connections += 1; callbacks = next; return { close: () => { closes += 1; } }; },
    notify: async (record) => {
      if (deferredNotify) await deferredNotify;
      if (notifyError) throw new Error('notification denied');
      order.push('notify');
      notifications.push(cycleNotificationContent(record.signal, record.direction, record.confidence));
    },
    publish: (state) => { snapshot = structuredClone(state); },
  });
  return {
    clock, session, storage, notifications, order,
    callbacks: () => callbacks,
    state: () => snapshot,
    connections: () => connections,
    closes: () => closes,
  };
}

function completeCycle(subject, start, move) {
  for (let index = 0; index < 60; index += 1) {
    const timestamp = start + index * 5000;
    subject.clock.advanceTo(timestamp);
    subject.callbacks().onStatus('CONECTADO');
    subject.callbacks().onPrice({ timestamp, price: 80000 * (1 + move * index / 60 / 100) });
  }
  subject.clock.advanceTo(start + 300000);
}

test('clearing completed history leaves the active window, prices, timer, feed and next completion intact', async () => {
  const subject = setup();
  await subject.session.start();
  completeCycle(subject, 1000, 1);
  await subject.session.flush();
  subject.clock.advanceTo(306000);
  subject.callbacks().onPrice({ timestamp: 306000, price: 81000 });
  subject.clock.advanceTo(311000);
  subject.callbacks().onPrice({ timestamp: 311000, price: 81001 });
  const before = subject.state();
  assert.equal(before.signalHistory.length, 1);
  assert.equal(before.isRunning, true);
  const timers = [...subject.clock.tasks.entries()];
  const store = createAnalysisHistoryStore(subject.storage);
  await store.clear();
  assert.deepEqual(subject.state(), { ...before, signalHistory: [] });
  assert.deepEqual([...subject.clock.tasks.entries()], timers);
  assert.equal(subject.connections(), 1);
  assert.equal(subject.closes(), 0);
  subject.clock.advanceTo(606000);
  await subject.session.flush();
  assert.equal(subject.state().isRunning, true);
  assert.equal(subject.state().signalHistory.length, 1);
  assert.equal(subject.state().signalHistory[0].timestamp, 606000);
  assert.deepEqual(await store.load(), subject.state().signalHistory);
  subject.session.stop();
});

test('delayed notifications cannot reinsert completions after clear; background history stays capped', async () => {
  let release;
  const subject = setup({ deferredNotify: new Promise((resolve) => { release = resolve; }) });
  await subject.session.start();
  for (let index = 0; index < 11; index++) {
    completeCycle(subject, 1000 + index * 300000, 1);
    assert.ok(subject.state().signalHistory.length <= 10);
  }
  const store = createAnalysisHistoryStore(subject.storage);
  await store.clear();
  assert.deepEqual(subject.state().signalHistory, []);
  release();
  await subject.session.flush();
  assert.deepEqual(subject.state().signalHistory, []);
  assert.deepEqual(await store.load(), []);
  assert.equal(subject.connections(), 1);
  assert.equal(subject.closes(), 0);
  subject.session.stop();
});

test('permission requests only notifications, asks when allowed, and does not re-prompt a final denial', async () => {
  for (const [initial, response, expected, calls] of [
    [{ granted: true, canAskAgain: true }, null, true, 0],
    [{ granted: false, canAskAgain: false }, null, false, 0],
    [{ granted: false, canAskAgain: true }, { granted: true, canAskAgain: true }, true, 1],
    [{ granted: false, canAskAgain: true }, { granted: false, canAskAgain: false }, false, 1],
  ]) {
    let asked = 0;
    assert.equal(await requestNotificationPermission({
      getPermissions: async () => initial,
      requestPermissions: async () => { asked += 1; return response; },
    }), expected);
    assert.equal(asked, calls);
  }
});

test('notification content includes every signal, trend, confirmation and five-minute conclusion', () => {
  for (const [signal, trend] of [['POSSÍVEL COMPRA', 'ALTA'], ['POSSÍVEL VENDA', 'BAIXA'], ['AGUARDAR', 'LATERAL']]) {
    const content = cycleNotificationContent(signal, trend, 86);
    assert.ok(content.title.includes(signal));
    assert.match(content.title, /5 minutos concluída/);
    assert.ok(content.body.includes(trend));
    assert.match(content.body, /86%/);
    assert.match(content.body, /não executa ordens/);
  }
});

test('headless session has one feed/timer, saves before each notification and automatically starts next cycle', async () => {
  const subject = setup();
  await Promise.all([subject.session.start(), subject.session.start()]);
  assert.equal(subject.connections(), 1);
  completeCycle(subject, 1000, 0.2);
  await subject.session.flush();
  const first = structuredClone(subject.state().signalHistory[0]);
  assert.equal(subject.state().cycleNumber, 2);
  assert.equal(subject.state().isRunning, true);
  completeCycle(subject, 301000, -0.2);
  await subject.session.flush();
  completeCycle(subject, 601000, 0);
  await subject.session.flush();
  assert.equal(subject.state().signalHistory.length, 3);
  assert.deepEqual(subject.state().signalHistory[0], first);
  assert.match(subject.notifications[0].title, /POSSÍVEL COMPRA/);
  assert.match(subject.notifications[1].title, /POSSÍVEL VENDA/);
  assert.match(subject.notifications[2].title, /AGUARDAR/);
  assert.deepEqual(subject.order, ['save', 'notify', 'save', 'notify', 'save', 'notify']);
  assert.equal(subject.clock.maxTimers, 1);
  assert.equal(subject.connections(), 1);
  const restored = await createAnalysisHistoryStore(subject.storage).load();
  assert.deepEqual(restored, subject.state().signalHistory);
  subject.session.stop();
  subject.clock.advanceTo(1500000);
  subject.callbacks().onPrice({ timestamp: 1500000, price: 90000 });
  assert.equal(subject.closes(), 1);
  assert.equal(subject.clock.tasks.size, 0);
  assert.equal(subject.state().isRunning, false);
  assert.equal(subject.notifications.length, 3);
});

test('denied notification does not stop collection or discard persisted cycle results', async () => {
  const subject = setup({ notifyError: true });
  await subject.session.start();
  completeCycle(subject, 1000, 0);
  await subject.session.flush();
  assert.match(subject.state().error, /notificação Android/);
  assert.equal(subject.state().isRunning, true);
  assert.equal((await createAnalysisHistoryStore(subject.storage).load()).length, 1);
  subject.session.stop();
});

test('STOP during a pending save preserves the completed result but cancels late notification', async () => {
  let release;
  const deferredWrite = new Promise((resolve) => { release = resolve; });
  const subject = setup({ deferredWrite });
  await subject.session.start();
  completeCycle(subject, 1000, 0.2);
  subject.session.stop();
  release();
  await subject.session.flush();
  assert.equal(subject.notifications.length, 0);
  assert.equal((await createAnalysisHistoryStore(subject.storage).load()).length, 1);
  assert.equal(subject.clock.tasks.size, 0);
});

test('reconnection and reopening UI do not create another owner or erase history; obsolete callbacks are ignored', async () => {
  const subject = setup();
  await subject.session.start();
  completeCycle(subject, 1000, 0.2);
  await subject.session.flush();
  const first = structuredClone(subject.state().signalHistory[0]);
  subject.callbacks().onStatus('RECONECTANDO');
  subject.clock.advanceTo(600000);
  assert.equal(subject.clock.tasks.size, 0);
  await subject.session.start(); // UI reattachment must never acquire ownership.
  assert.equal(subject.connections(), 1);
  completeCycle(subject, 600000, -0.2);
  await subject.session.flush();
  assert.deepEqual(subject.state().signalHistory[0], first);
  const oldCallbacks = subject.callbacks();
  subject.session.stop();
  await subject.session.start();
  oldCallbacks.onStatus('RECONECTANDO');
  oldCallbacks.onPrice({ timestamp: 900000, price: 1 });
  assert.equal(subject.state().history.length, 0);
  assert.equal(subject.state().signalHistory.length, 2);
  assert.equal(subject.connections(), 2, 'one new connection only after explicit STOP/restart');
  subject.session.stop();
});

test('learning hooks observe the existing feed, register completions and stop/reconnect without replacing five-minute cycles', async () => {
  const events = [];
  const subject = setup({ learning: {
    register: (record) => events.push(['signal', record.timestamp, record.signal]),
    observe: (point) => events.push(['price', point.timestamp]),
    interrupt: () => events.push(['interrupt']),
  } });
  await subject.session.start();
  completeCycle(subject, 1000, 0.2);
  await subject.session.flush();
  assert.equal(events.filter((e) => e[0] === 'price').length, 60);
  assert.deepEqual(events.at(-1), ['signal', 301000, 'POSSÍVEL COMPRA']);
  assert.equal(subject.state().signalHistory.length, 1);
  assert.equal(subject.connections(), 1);
  assert.equal(subject.clock.maxTimers, 1);
  subject.callbacks().onStatus('RECONECTANDO');
  assert.deepEqual(events.at(-1), ['interrupt']);
  subject.session.stop();
  assert.deepEqual(events.at(-1), ['interrupt']);
  const count = events.length;
  subject.callbacks().onPrice({ timestamp: 500000, price: 80000 });
  assert.equal(events.length, count);
  assert.equal(subject.closes(), 1);
});

test('real learning implementation evaluates the subsequent existing-feed quotes while collection keeps running', async () => {
  // Unit-test-only prices and storage; never seeds production statistics.
  const values = new Map();
  const learning = createSignalLearningStore({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
  });
  await learning.load();
  const subject = setup({ learning });
  await subject.session.start();
  completeCycle(subject, 1000, 0.2);
  const entry = 301001;
  subject.clock.advanceTo(entry);
  subject.callbacks().onPrice({ timestamp: entry, price: 80000 });
  for (let minutes = 1; minutes <= 5; minutes++) {
    const timestamp = entry + minutes * 60000;
    subject.clock.advanceTo(timestamp);
    subject.callbacks().onPrice({ timestamp, price: 80000 + minutes });
  }
  await learning.flush();
  await subject.session.flush();
  const results = learning.snapshot().data;
  assert.equal(results.recent[0].signal, 'POSSÍVEL COMPRA');
  assert.deepEqual(results.recent[0].results.map((r) => r.status), Array(5).fill('POSITIVO'));
  assert.equal(results.stats['POSSÍVEL COMPRA'].comparable[4].evaluated, 1);
  assert.equal(subject.connections(), 1);
  assert.equal(subject.state().isRunning, true);
  assert.equal(subject.clock.maxTimers, 1);
  subject.session.stop();
});