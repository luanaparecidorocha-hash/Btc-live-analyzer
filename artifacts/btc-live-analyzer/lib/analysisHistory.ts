import type { Signal } from './analysis';

export type AnalysisRecord = {
  timestamp: number;
  signal: Signal;
  direction: 'ALTA' | 'BAIXA' | 'LATERAL';
  confidence: number;
  durationMs: number | null;
  reason: string;
};

export const ANALYSIS_HISTORY_KEY = '@btc-live-analyzer/signal-history';

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
    return {
      timestamp: entry.timestamp as number,
      signal: entry.signal as Signal,
      direction: entry.direction as AnalysisRecord['direction'],
      confidence: entry.confidence,
      durationMs: entry.durationMs as number | null | undefined ?? null,
      reason: entry.reason,
    };
  });
}

export function mergeAnalysisHistory(
  saved: AnalysisRecord[],
  session: AnalysisRecord[],
): AnalysisRecord[] {
  const entries = new Map<number, AnalysisRecord>();
  for (const record of [...saved, ...session]) entries.set(record.timestamp, record);
  return [...entries.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export function createAnalysisHistoryStore(storage: HistoryStorage) {
  let records: AnalysisRecord[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  async function read() {
    if (records === null) records = decodeAnalysisHistory(await storage.getItem(ANALYSIS_HISTORY_KEY));
    return records;
  }
  return {
    load: () => enqueue(async () => [...await read()]),
    append: (record: AnalysisRecord) => enqueue(async () => {
      records = mergeAnalysisHistory(await read(), [record]);
      // Retain the in-memory record on a write failure. The next append retries
      // the complete history; never overwrite unread/corrupt persisted data.
      await storage.setItem(ANALYSIS_HISTORY_KEY, JSON.stringify(records));
      return [...records];
    }),
  };
}