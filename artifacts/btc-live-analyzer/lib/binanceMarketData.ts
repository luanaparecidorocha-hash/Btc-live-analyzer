// Independent observation feed. Never pass these USDT quotes to the BTC/USD signal engine.
export const BINANCE_BTC_USDT_URL = 'wss://data-stream.binance.vision/ws/btcusdt@miniTicker';

export type BinanceQuote = Readonly<{
  source: 'BINANCE';
  symbol: 'BTCUSDT';
  quoteCurrency: 'USDT';
  price: number;
  eventTime: number;
  receivedAt: number;
}>;

export type BinanceFeedSnapshot = Readonly<{
  status: 'DESATIVADA' | 'CONECTANDO' | 'CONECTADO' | 'RECONECTANDO';
  latest: BinanceQuote | null;
  recentQuotes: readonly BinanceQuote[];
  receivedCount: number;
  error: string | null;
}>;

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const NO_DATA_TIMEOUT_MS = 45_000;
const HISTORY_LIMIT = 300;

export function parseBinanceMiniTicker(payload: string, receivedAt = Date.now()): BinanceQuote | null {
  let data: unknown;
  try { data = JSON.parse(payload); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.e !== '24hrMiniTicker' || message.s !== 'BTCUSDT') return null;
  if (typeof message.c !== 'string' || !message.c.trim()) return null;
  const price = Number(message.c);
  if (!Number.isFinite(price) || price <= 0
    || typeof message.E !== 'number' || !Number.isSafeInteger(message.E) || message.E <= 0
    || !Number.isFinite(receivedAt) || receivedAt <= 0) return null;
  return Object.freeze({
    source: 'BINANCE', symbol: 'BTCUSDT', quoteCurrency: 'USDT',
    price, eventTime: message.E, receivedAt,
  });
}

/**
 * In-memory only: last quote, explicit connection/error state, and up to 300 recent
 * updates for future comparisons. miniTicker publishes the last price every ~1s;
 * it is NOT a candle, a USD quote, or a five-minute analysis window.
 */
export function createBinanceMarketFeed() {
  let snapshot: BinanceFeedSnapshot = Object.freeze({
    status: 'DESATIVADA', latest: null, recentQuotes: Object.freeze([]),
    receivedCount: 0, error: null,
  });
  let running = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const listeners = new Set<() => void>();

  const publish = (changes: Partial<BinanceFeedSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...changes });
    for (const listener of listeners) listener();
  };
  const clearWatchdog = () => {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = null;
  };
  const releaseSocket = () => {
    const previous = socket;
    socket = null;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
      // Some transports can throw while closing a failed handshake.
      try { if (previous.readyState < 2) previous.close(); } catch { /* Already failed. */ }
    }
    clearWatchdog();
  };
  const reconnect = (error: string) => {
    if (!running || retry !== null) return;
    releaseSocket();
    publish({ status: 'RECONECTANDO', error });
    const delay = RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)];
    retry = setTimeout(() => { retry = null; open(); }, delay);
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = null;
      reconnect('Binance BTC/USDT sem dados recentes. Tentando reconectar.');
    }, NO_DATA_TIMEOUT_MS);
  };
  const open = () => {
    if (!running) return;
    publish({ status: attempt === 0 ? 'CONECTANDO' : 'RECONECTANDO' });
    try {
      const active = new WebSocket(BINANCE_BTC_USDT_URL);
      socket = active;
      armWatchdog();
      active.onmessage = (event) => {
        if (!running || socket !== active) return;
        const quote = parseBinanceMiniTicker(String(event.data));
        if (!quote) return;
        // Do not let delayed/duplicate exchange events replace newer observations.
        if (snapshot.latest && quote.eventTime <= snapshot.latest.eventTime) return;
        attempt = 0;
        armWatchdog();
        publish({
          status: 'CONECTADO', error: null, latest: quote,
          recentQuotes: Object.freeze([...snapshot.recentQuotes.slice(-(HISTORY_LIMIT - 1)), quote]),
          receivedCount: snapshot.receivedCount + 1,
        });
      };
      active.onerror = () => {
        if (running && socket === active) reconnect('Falha na conexão pública Binance BTC/USDT.');
      };
      active.onclose = () => {
        if (running && socket === active) reconnect('Conexão pública Binance BTC/USDT encerrada.');
      };
      // Browser/RN transports handle protocol ping/pong; no account or JSON login.
      // CONECTADO is set only after a valid BTCUSDT quote, not merely an open socket.
    } catch {
      reconnect('Não foi possível abrir a conexão pública Binance BTC/USDT.');
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start: () => {
      if (running) return;
      running = true;
      attempt = 0;
      publish({ error: null });
      open();
    },
    stop: () => {
      running = false;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      releaseSocket();
      publish({ status: 'DESATIVADA', error: null });
    },
  };
}

export const binanceMarketFeed = createBinanceMarketFeed();
