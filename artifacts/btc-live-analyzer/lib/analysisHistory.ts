import type { Signal } from './analysis';
import type { CrossConfirmation } from './crossConfirmation';

export type AnalysisRecord = {
  timestamp: number;
  signal: Signal;
  direction: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  durationMs: number | null;
  reason: string;
  // Optional for backward compatibility: older results were Kraken-only.
  crossConfirmation?: CrossConfirmation;
};

export const ANALYSIS_HISTORY_KEY = '@btc-live-analyzer/signal-history';
export const ANALYSIS_HISTORY_LIMIT = 10;

type HistoryStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export function decodeAnalysisHistory(raw: string | null): AnalysisRecord[] {
  if (raw === null) return [];
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values)) throw new Error('Histórico salvo inválido.');
  return values.map((value: unknown) => {
    if (typeof value !== 'object' || value === null) throw new Error('Análise salva inválida.');
    const entry = value as Record<string, unknown>;
    if (
      !Number.isFinite(entry.timestamp)
      || !['POSSÍVEL COMPRA', 'POSSÍVEL VENDA', 'AGUARDAR'].includes(String(entry.signal))
      || !['ALTA', 'BAIXA', 'LATERAL'].includes(String(entry.direction))
      || typeof entry.confidence !== 'number'
      || !Number.isFinite(entry.confidence)
      || entry.confidence < 0 || entry.confidence > 100
      || typeof entry.reason !== 'string'
      || (entry.durationMs !== undefined && entry.durationMs !== null
        && (typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0))
    ) throw new Error('Análise salva inválida.');
    if (entry.crossConfirmation !== undefined) {
      const cross = entry.crossConfirmation as Record<string, unknown> | null;
      const directions = ['ALTA', 'BAIXA', 'LATERAL', 'INSUFICIENTE'];
      const signals = ['POSSÍVEL COMPRA', 'POSSÍVEL VENDA', 'AGUARDAR'];
      if (!cross || typeof cross !== 'object' || Array.isArray(cross)
        || !directions.includes(String(cross.krakenDirection))
        || !directions.includes(String(cross.binanceDirection))
        || !['CONCORDANCIA', 'CONFLITO', 'NEUTRO', 'DADOS_INSUFICIENTES'].includes(String(cross.agreement))
        || !['ALTA_CONFIRMADA', 'BAIXA_CONFIRMADA', 'SEM_CONFIRMACAO'].includes(String(cross.finalConfirmation))
        || !signals.includes(String(cross.krakenSignal)) || !signals.includes(String(cross.binanceSignal))
        || cross.finalSignal !== entry.signal || cross.finalConfidence !== entry.confidence
        || ['finalConfidence', 'krakenConfidence', 'binanceConfidence', 'confidenceBonus'].some((key) => (
          typeof cross[key] !== 'number' || !Number.isFinite(cross[key]) || cross[key] < 0 || cross[key] > 100
        ))
        || typeof cross.windowStart !== 'number' || !Number.isFinite(cross.windowStart)
        || typeof cross.windowEnd !== 'number' || !Number.isFinite(cross.windowEnd)
        || cross.windowEnd <= cross.windowStart
      ) throw new Error('Confirmação cruzada salva inválida.');
    }
    return {
      timestamp: entry.timestamp as number,
      signal: entry.signal as Signal,
      direction: entry.direction as AnalysisRecord['direction'],
      confidence: entry.confidence,
      durationMs: entry.durationMs as number | null | undefined ?? null,
      reason: entry.reason,
      ...(entry.crossConfirmation === undefined ? {} : {
        crossConfirmation: entry.crossConfirmation as CrossConfirmation,
      }),
    };
  });
}

export function mergeAnalysisHistory(
  saved: AnalysisRecord[],
  session: AnalysisRecord[],
): AnalysisRecord[] {
  const entries = new Map<number, AnalysisRecord>();
  for (const record of [...saved, ...session]) entries.set(record.timestamp, record);
  return [...entries.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-ANALYSIS_HISTORY_LIMIT);
}

// UI and Android headless execution must share the existing store's queue/cache.
const stores = new WeakMap<HistoryStorage, ReturnType<typeof buildAnalysisHistoryStore>>();

export function createAnalysisHistoryStore(storage: HistoryStorage) {
  let store = stores.get(storage);
  if (!store) {
    store = buildAnalysisHistoryStore(storage);
    stores.set(storage, store);
  }
  return store;
}

function buildAnalysisHistoryStore(storage: HistoryStorage) {
  let records: AnalysisRecord[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(records: AnalysisRecord[]) => void>();
  function publish() {
    for (const listener of listeners) {
      try { listener([...(records ?? [])]); }
      catch (error) { console.warn('Não foi possível atualizar a exibição do histórico.', error); }
    }
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function read() {
    if (records === null) {
      const saved = decodeAnalysisHistory(await storage.getItem(ANALYSIS_HISTORY_KEY));
      const latest = mergeAnalysisHistory(saved, []);
      if (saved.length > ANALYSIS_HISTORY_LIMIT) {
        await storage.setItem(ANALYSIS_HISTORY_KEY, JSON.stringify(latest));
      }
      records = latest;
    }
    return records;
  }
  return {
    merge: mergeAnalysisHistory,
    load: () => enqueue(async () => {
      await read();
      publish();
      return [...records!];
    }),
    subscribe: (listener: (records: AnalysisRecord[]) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    append: (record: AnalysisRecord) => enqueue(async () => {
      records = mergeAnalysisHistory(await read(), [record]);
      publish();
      // Retain the in-memory record on a write failure. The next append retries
      // the complete history; never overwrite unread/corrupt persisted data.
      await storage.setItem(ANALYSIS_HISTORY_KEY, JSON.stringify(records));
      return [...records];
    }),
    clear: () => enqueue(async () => {
      // Only clear the cache/UI after persistence succeeds. A later completion
      // queues behind this operation; an earlier completion cannot resurrect.
      await storage.setItem(ANALYSIS_HISTORY_KEY, '[]');
      records = [];
      publish();
      return [];
    }),
  };
}