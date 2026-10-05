import type { ChartPoint, AnalysisResult } from './analysis';
import type { AnalysisRecord } from './analysisHistory';
import type { MarketFeedConnection, MarketFeedStatus, MarketPricePoint } from './marketData';

export type AnalysisSessionSnapshot = {
  isRunning: boolean;
  marketStatus: MarketFeedStatus;
  history: ChartPoint[];
  collectionStartedAt: number | null;
  clockNow: number;
  cycleNumber: number;
  currentPrice: number | null;
  lastPriceAt: number | null;
  signalHistory: AnalysisRecord[];
  completedCycle: AnalysisRecord | null;
  error: string | null;
};

type Collection = {
  start: () => void;
  stop: () => void;
  reconnect: () => void;
  push: (point: ChartPoint) => void;
};

type SessionDependencies = {
  windowMs: number;
  analyze: (points: ChartPoint[], windowMs: number, now: number) => AnalysisResult;
  createCollection: (callbacks: {
    windowMs: number;
    onUpdate: (state: { startedAt: number | null; now: number; cycleNumber: number; points: ChartPoint[] }) => void;
    onComplete: (points: readonly ChartPoint[], completedAt: number) => void;
  }) => Collection;
  connect: (callbacks: {
    onPrice: (point: MarketPricePoint) => void;
    onStatus: (status: MarketFeedStatus) => void;
    onError: (message: string) => void;
  }) => MarketFeedConnection;
  store: { load: () => Promise<AnalysisRecord[]>; append: (record: AnalysisRecord) => Promise<AnalysisRecord[]> };
  notify: (record: AnalysisRecord) => Promise<void>;
  publish: (state: AnalysisSessionSnapshot) => void;
};

/**
 * Android execution owner. Uses injected EXISTING feed, collector, engine and
 * history store; contains no price classification or signal thresholds.
 */
export function createAnalysisSession(dependencies: SessionDependencies) {
  let generation = 0;
  let feed: MarketFeedConnection | null = null;
  let state: AnalysisSessionSnapshot = {
    isRunning: false, marketStatus: 'DESATIVADA', history: [],
    collectionStartedAt: null, clockNow: 0, cycleNumber: 1,
    currentPrice: null, lastPriceAt: null, signalHistory: [],
    completedCycle: null, error: null,
  };
  let saving: Promise<void> = Promise.resolve();
  function publish() {
    dependencies.publish({ ...state, history: [...state.history], signalHistory: [...state.signalHistory] });
  }
  const collection = dependencies.createCollection({
    windowMs: dependencies.windowMs,
    onUpdate: (next) => {
      state = { ...state, history: next.points, collectionStartedAt: next.startedAt,
        clockNow: next.now, cycleNumber: next.cycleNumber };
      publish();
    },
    onComplete: (points, completedAt) => {
      const result = dependencies.analyze([...points], dependencies.windowMs, completedAt);
      const record: AnalysisRecord = {
        timestamp: completedAt, signal: result.signal, direction: result.trend,
        confidence: result.confidence, durationMs: dependencies.windowMs, reason: result.reason,
        ...(result.crossConfirmation ? { crossConfirmation: result.crossConfirmation } : {}),
      };
      state = { ...state, completedCycle: record, signalHistory: [...state.signalHistory, record] };
      publish();
      const currentGeneration = generation;
      // Persist BEFORE notifying, serialize every completed cycle, and never
      // deliver a late notification after the user has stopped the session.
      saving = saving.then(async () => {
        try {
          const saved = await dependencies.store.append(record);
          const merged = new Map([...saved, ...state.signalHistory].map((entry) => [entry.timestamp, entry]));
          state = { ...state, signalHistory: [...merged.values()].sort((a, b) => a.timestamp - b.timestamp), error: null };
        } catch {
          state = { ...state, error: 'Resultado mantido na sessão; não foi possível salvar o histórico no dispositivo.' };
        }
        publish();
        if (state.isRunning && generation === currentGeneration) {
          try { await dependencies.notify(record); }
          catch { state = { ...state, error: 'O ciclo foi concluído, mas a notificação Android não pôde ser exibida.' }; publish(); }
        }
      });
    },
  });
  return {
    start: async () => {
      if (state.isRunning) return;
      const token = ++generation;
      state = { ...state, isRunning: true, error: null, completedCycle: null };
      publish();
      try {
        const saved = await dependencies.store.load();
        state = { ...state, signalHistory: saved };
      } catch {
        state = { ...state, error: 'Não foi possível carregar o histórico salvo; dados antigos não serão sobrescritos.' };
      }
      if (!state.isRunning || token !== generation) return;
      collection.start();
      state = { ...state, marketStatus: 'CONECTANDO' };
      publish();
      feed = dependencies.connect({
        onPrice: (point) => {
          if (!state.isRunning || token !== generation) return;
          state = { ...state, currentPrice: point.price, lastPriceAt: point.timestamp };
          collection.push(point);
        },
        onStatus: (status) => {
          if (!state.isRunning || token !== generation) return;
          state = { ...state, marketStatus: status };
          if (status === 'RECONECTANDO') {
            state = { ...state, currentPrice: null, lastPriceAt: null };
            collection.reconnect();
          }
          publish();
        },
        onError: (message) => {
          if (!state.isRunning || token !== generation) return;
          state = { ...state, error: message };
          publish();
        },
      });
    },
    stop: () => {
      ++generation;
      state = { ...state, isRunning: false, marketStatus: 'DESATIVADA', currentPrice: null, lastPriceAt: null };
      collection.stop();
      feed?.close();
      feed = null;
      publish();
    },
    flush: () => saving,
  };
}