import type { AnalysisRecord } from './analysisHistory';
import type { MarketPricePoint } from './marketData';

export const LEARNING_KEY = '@btc-live-analyzer/horizon-results-v1';
export const HORIZONS = [1, 2, 3, 4, 5] as const;
export const MIN_LEARNING_SAMPLES = 30;
export const QUOTE_TOLERANCE_MS = 15_000;
const RECENT_LIMIT = 100;
export type TradeSignal = 'POSSÍVEL COMPRA' | 'POSSÍVEL VENDA';
type Outcome = 'PENDENTE' | 'POSITIVO' | 'NEGATIVO' | 'NEUTRO' | 'SEM_DADOS';
export type HorizonResult = {
  minutes: number;
  status: Outcome;
  observedAt: number | null;
  price: number | null;
  variationPct: number | null;
};
export type TrackedSignal = {
  timestamp: number;
  signal: TradeSignal;
  predictedDirection: 'ALTA' | 'BAIXA';
  entry: MarketPricePoint | null;
  results: HorizonResult[];
};
export type HorizonStats = {
  minutes: number;
  evaluated: number;
  positive: number;
  negative: number;
  neutral: number;
  variationSumPct: number;
};
type DirectionStats = { all: HorizonStats[]; comparable: HorizonStats[] };
export type LearningData = {
  version: 1;
  lastQuoteAt: number;
  lastSignalAt: number;
  pending: TrackedSignal[];
  recent: TrackedSignal[];
  stats: Record<TradeSignal, DirectionStats>;
};
export type LearningSnapshot = { data: LearningData; loaded: boolean; error: string | null };
export type DurationRecommendation = {
  minutes: number;
  hitRate: number;
  samples: number;
} | null;

const trades: TradeSignal[] = ['POSSÍVEL COMPRA', 'POSSÍVEL VENDA'];
const emptyStats = (): HorizonStats[] => HORIZONS.map((minutes) => ({
  minutes, evaluated: 0, positive: 0, negative: 0, neutral: 0, variationSumPct: 0,
}));
export function emptyLearningData(): LearningData {
  return {
    version: 1, lastQuoteAt: 0, lastSignalAt: 0, pending: [], recent: [],
    stats: {
      'POSSÍVEL COMPRA': { all: emptyStats(), comparable: emptyStats() },
      'POSSÍVEL VENDA': { all: emptyStats(), comparable: emptyStats() },
    },
  };
}

/** No interpolation, old prices, simulated observations or USD/USDT mixing. */
export function registerLearningSignal(data: LearningData, record: AnalysisRecord): boolean {
  if (!trades.includes(record.signal as TradeSignal)
    || !Number.isFinite(record.timestamp) || record.timestamp <= data.lastSignalAt) return false;
  data.lastSignalAt = record.timestamp;
  data.pending.push({
    timestamp: record.timestamp, signal: record.signal as TradeSignal,
    predictedDirection: record.signal === 'POSSÍVEL COMPRA' ? 'ALTA' : 'BAIXA',
    entry: null,
    results: HORIZONS.map((minutes) => ({
      minutes, status: 'PENDENTE', observedAt: null, price: null, variationPct: null,
    })),
  });
  return true;
}

function count(stats: HorizonStats, result: HorizonResult) {
  if (result.variationPct === null) return;
  stats.evaluated += 1;
  stats.positive += Number(result.status === 'POSITIVO');
  stats.negative += Number(result.status === 'NEGATIVO');
  stats.neutral += Number(result.status === 'NEUTRO');
  stats.variationSumPct += result.variationPct;
}
function finishClosed(data: LearningData) {
  const open: TrackedSignal[] = [];
  for (const record of data.pending) {
    if (record.results.some((result) => result.status === 'PENDENTE')) {
      open.push(record);
      continue;
    }
    // Compare exactly the same signals at every duration, avoiding missing-data bias.
    if (record.results.every((result) => result.variationPct !== null)) {
      record.results.forEach((result, index) => count(data.stats[record.signal].comparable[index], result));
    }
    data.recent.push(record);
  }
  data.pending = open;
  data.recent = data.recent.slice(-RECENT_LIMIT);
}
export function observeLearningPrice(data: LearningData, point: MarketPricePoint): boolean {
  if (!Number.isFinite(point.price) || point.price <= 0 || !Number.isFinite(point.timestamp)
    || point.timestamp <= data.lastQuoteAt) return false;
  data.lastQuoteAt = point.timestamp;
  let changed = false;
  for (const record of data.pending) {
    if (point.timestamp < record.timestamp) continue;
    if (!record.entry) {
      if (point.timestamp - record.timestamp > QUOTE_TOLERANCE_MS) {
        record.results.forEach((result) => { result.status = 'SEM_DADOS'; });
      } else {
        // First real quote after signal emission, not the old cycle's final quote.
        record.entry = { ...point };
      }
      changed = true;
    }
    if (!record.entry) continue;
    record.results.forEach((result, index) => {
      if (result.status !== 'PENDENTE') return;
      const deadline = record.entry!.timestamp + result.minutes * 60_000;
      if (point.timestamp < deadline) return;
      changed = true;
      if (point.timestamp - deadline > QUOTE_TOLERANCE_MS) {
        result.status = 'SEM_DADOS';
        return;
      }
      const variation = (point.price / record.entry!.price - 1) * 100;
      if (!Number.isFinite(variation)) { result.status = 'SEM_DADOS'; return; }
      const directionalMove = record.predictedDirection === 'ALTA' ? variation : -variation;
      result.status = directionalMove > 0 ? 'POSITIVO' : directionalMove < 0 ? 'NEGATIVO' : 'NEUTRO';
      result.price = point.price;
      result.observedAt = point.timestamp;
      result.variationPct = variation;
      count(data.stats[record.signal].all[index], result);
    });
  }
  if (changed) finishClosed(data);
  return changed;
}
export function interruptLearning(data: LearningData): boolean {
  if (!data.pending.length) return false;
  for (const record of data.pending) {
    record.results.forEach((result) => {
      if (result.status === 'PENDENTE') result.status = 'SEM_DADOS';
    });
  }
  finishClosed(data);
  return true;
}
export function recommendDuration(data: LearningData, signal: TradeSignal): DurationRecommendation {
  const stats = data.stats[signal].comparable;
  if (stats.some((item) => item.evaluated < MIN_LEARNING_SAMPLES)) return null;
  // Maximise hit rate; on an exact tie choose the shorter duration deterministically.
  const best = [...stats].sort((a, b) => b.positive / b.evaluated - a.positive / a.evaluated || a.minutes - b.minutes)[0];
  return { minutes: best.minutes, hitRate: best.positive / best.evaluated * 100, samples: best.evaluated };
}

/** Refuse corrupt data; never silently overwrite an unreadable learning history. */
export function decodeLearningData(raw: string | null): LearningData {
  if (raw === null) return emptyLearningData();
  const data = JSON.parse(raw) as LearningData;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
  const validStats = (items: HorizonStats[]) => Array.isArray(items) && items.length === 5
    && items.every((item, i) => item && item.minutes === HORIZONS[i]
      && [item.evaluated, item.positive, item.negative, item.neutral].every(integer)
      && item.evaluated === item.positive + item.negative + item.neutral
      && Number.isFinite(item.variationSumPct));
  const validRecord = (record: TrackedSignal) => record && finitePositive(record.timestamp)
    && trades.includes(record.signal)
    && record.predictedDirection === (record.signal === 'POSSÍVEL COMPRA' ? 'ALTA' : 'BAIXA')
    && (record.entry === null || (finitePositive(record.entry.price)
      && record.entry.timestamp >= record.timestamp
      && record.entry.timestamp <= record.timestamp + QUOTE_TOLERANCE_MS))
    && Array.isArray(record.results) && record.results.length === 5
    && record.results.every((result, index) => {
      if (!result || result.minutes !== HORIZONS[index]) return false;
      if (result.status === 'PENDENTE' || result.status === 'SEM_DADOS') {
        return result.price === null && result.observedAt === null && result.variationPct === null;
      }
      if (!record.entry || !finitePositive(result.price!)
        || !Number.isFinite(result.variationPct) || !Number.isFinite(result.observedAt)) return false;
      const deadline = record.entry.timestamp + result.minutes * 60_000;
      const variation = (result.price! / record.entry.price - 1) * 100;
      const movement = record.predictedDirection === 'ALTA' ? variation : -variation;
      const status = movement > 0 ? 'POSITIVO' : movement < 0 ? 'NEGATIVO' : 'NEUTRO';
      return result.status === status && Math.abs(result.variationPct! - variation) < 1e-9
        && result.observedAt! >= deadline && result.observedAt! <= deadline + QUOTE_TOLERANCE_MS;
    });
  if (!data || data.version !== 1 || !integer(data.lastQuoteAt) || !integer(data.lastSignalAt)
    || !Array.isArray(data.pending) || data.pending.length > 16
    || !Array.isArray(data.recent) || data.recent.length > RECENT_LIMIT
    || ![...data.pending, ...data.recent].every(validRecord)
    || data.pending.some((record) => !record.results.some((r) => r.status === 'PENDENTE'))
    || data.recent.some((record) => record.results.some((r) => r.status === 'PENDENTE'))
    || !data.stats || !trades.every((signal) => data.stats[signal]
      && validStats(data.stats[signal].all) && validStats(data.stats[signal].comparable)
      && data.stats[signal].comparable.every((item, i) => item.evaluated <= data.stats[signal].all[i].evaluated)
      && new Set(data.stats[signal].comparable.map((item) => item.evaluated)).size === 1)) {
    throw new Error('Resultados históricos de duração inválidos.');
  }
  return data;
}

type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> };
const stores = new WeakMap<Storage, ReturnType<typeof buildStore>>();
export function createSignalLearningStore(storage: Storage) {
  let store = stores.get(storage);
  if (!store) { store = buildStore(storage); stores.set(storage, store); }
  return store;
}
function buildStore(storage: Storage) {
  let state: LearningSnapshot = { data: emptyLearningData(), loaded: false, error: null };
  let loading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<(state: LearningSnapshot) => void>();
  const snapshot = () => JSON.parse(JSON.stringify(state)) as LearningSnapshot;
  function publish() {
    for (const listener of listeners) {
      try { listener(snapshot()); } catch (error) { console.warn('Falha na exibição do aprendizado.', error); }
    }
  }
  function save() {
    const json = JSON.stringify(state.data);
    publish();
    writes = writes.then(async () => {
      try { await storage.setItem(LEARNING_KEY, json); state.error = null; }
      catch { state.error = 'Não foi possível salvar o aprendizado; resultados desta sessão ainda não estão persistidos.'; }
      publish();
    });
  }
  return {
    snapshot,
    subscribe: (listener: (state: LearningSnapshot) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load: () => {
      if (!loading) loading = (async () => {
        try {
          state.data = decodeLearningData(await storage.getItem(LEARNING_KEY));
          state.loaded = true;
          // A dead process did not observe these prices. Never score them retrospectively.
          if (interruptLearning(state.data)) save();
          else publish();
        } catch (error) {
          state.error = 'Aprendizado indisponível: não foi possível ler os resultados salvos. Os dados não serão sobrescritos.';
          publish();
          throw error;
        }
      })();
      return loading;
    },
    register: (record: AnalysisRecord) => {
      if (state.loaded && registerLearningSignal(state.data, record)) save();
    },
    observe: (point: MarketPricePoint) => {
      if (state.loaded && observeLearningPrice(state.data, point)) save();
    },
    interrupt: () => {
      if (state.loaded && interruptLearning(state.data)) save();
    },
    recommendation: (signal: TradeSignal) => state.loaded && !state.error
      ? recommendDuration(state.data, signal) : null,
    flush: () => writes,
  };
}
