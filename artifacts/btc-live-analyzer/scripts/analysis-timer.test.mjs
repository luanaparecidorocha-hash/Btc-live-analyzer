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
