import type { ChartPoint, DeadlineScheduler } from './analysis';

type CycleState = {
  startedAt: number | null;
  now: number;
  cycleNumber: number;
  points: ChartPoint[];
};

type CollectionOptions = {
  windowMs: number;
  onUpdate: (state: CycleState) => void;
  onComplete: (points: readonly ChartPoint[], completedAt: number) => void;
};

const systemClock: DeadlineScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** Collection lifecycle only; all signal decisions remain in analyzeChart. */
export function createContinuousCollection(options: CollectionOptions, clock = systemClock) {
  let running = false;
  let startedAt: number | null = null;
  let points: ChartPoint[] = [];
  let completedCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }
  function publish(now: number) {
    options.onUpdate({
      startedAt, now, cycleNumber: completedCount + 1,
      points: points.map((point) => ({ ...point })),
    });
  }
  function advance(now: number) {
    if (running && startedAt !== null && now >= startedAt + options.windowMs) {
      const deadline = startedAt + options.windowMs;
      const frozen = Object.freeze(points.map((point) => Object.freeze({ ...point })));
      // Close atomically before invoking callbacks. The next window anchors
      // to its first NEW live quote, matching the unchanged engine's full-
      // window gate without fabricating a boundary price or reusing old data.
      startedAt = null;
      points = [];
      completedCount += 1;
      options.onComplete(frozen, deadline);
    }
  }
  function armTimer() {
    if (!running || startedAt === null || timer !== null) return;
    const remaining = startedAt + options.windowMs - clock.now();
    timer = clock.setTimeout(() => {
      timer = null;
      if (!running) return;
      const now = clock.now();
      advance(now);
      publish(now);
      armTimer();
    }, Math.max(0, Math.min(1000, remaining)));
  }

  return {
    isRunning: () => running,
    start: () => {
      if (running) return;
      running = true;
      startedAt = null;
      points = [];
      completedCount = 0;
      publish(clock.now());
    },
    push: (point: ChartPoint) => {
      if (!running || !Number.isFinite(point.timestamp) || !Number.isFinite(point.price) || point.price <= 0) return;
      if (startedAt === null) startedAt = point.timestamp;
      if (point.timestamp < startedAt) return;
      advance(point.timestamp);
      if (!running) return;
      if (startedAt === null) startedAt = point.timestamp;
      const last = points[points.length - 1];
      if (!last || point.timestamp - last.timestamp >= 5000) points.push({ ...point });
      publish(point.timestamp);
      armTimer();
    },
    reconnect: () => {
      if (!running) return;
      // Discard only the incomplete window; saved completed cycles are external.
      cancelTimer();
      startedAt = null;
      points = [];
      publish(clock.now());
    },
    stop: () => {
      running = false;
      cancelTimer();
      startedAt = null;
      points = [];
      publish(clock.now());
    },
  };
}