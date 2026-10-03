export type MarketPricePoint = {
  timestamp: number;
  price: number;
};

export type MarketFeedStatus =
  | 'DESATIVADA'
  | 'CONECTANDO'
  | 'CONECTADO'
  | 'RECONECTANDO';

type KrakenTickerMessage = {
  channel?: string;
  data?: Array<{
    symbol?: string;
    last?: number | string;
    timestamp?: string;
  }>;
  success?: boolean;
  error?: string;
  message?: string;
};

type MarketFeedCallbacks = {
  onPrice: (point: MarketPricePoint) => void;
  onStatus: (status: MarketFeedStatus) => void;
  onError: (message: string) => void;
};

export type MarketFeedConnection = {
  close: () => void;
};

const KRAKEN_TICKER_URL = 'wss://ws.kraken.com/v2';
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export function parseKrakenTickerMessage(
  payload: string,
  receivedAt = Date.now(),
): MarketPricePoint | null {
  let message: KrakenTickerMessage;
  try {
    message = JSON.parse(payload) as KrakenTickerMessage;
  } catch {
    return null;
  }

  if (message.channel !== 'ticker' || !Array.isArray(message.data)) return null;
  const ticker = message.data.find((item) => item.symbol === 'BTC/USD');
  if (!ticker) return null;

  const price = Number(ticker.last);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    // Count the user's live collection window from receipt, not the exchange's last-trade timestamp.
    timestamp: receivedAt,
    price,
  };
}

export function connectBtcUsdTicker(callbacks: MarketFeedCallbacks): MarketFeedConnection {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    callbacks.onStatus('RECONECTANDO');
    const delay = RECONNECT_DELAYS_MS[Math.min(retryAttempt, RECONNECT_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      openSocket();
    }, delay);
  };

  const openSocket = () => {
    if (stopped) return;
    callbacks.onStatus(retryAttempt === 0 ? 'CONECTANDO' : 'RECONECTANDO');

    try {
      const nextSocket = new WebSocket(KRAKEN_TICKER_URL);
      socket = nextSocket;

      nextSocket.onopen = () => {
        if (stopped || socket !== nextSocket) return;
        nextSocket.send(JSON.stringify({
          method: 'subscribe',
          params: {
            channel: 'ticker',
            symbol: ['BTC/USD'],
            event_trigger: 'trades',
            snapshot: true,
          },
        }));
      };

      nextSocket.onmessage = (event) => {
        if (stopped || socket !== nextSocket) return;
        const rawMessage = String(event.data);
        let message: KrakenTickerMessage;
        try {
          message = JSON.parse(rawMessage) as KrakenTickerMessage;
        } catch {
          return;
        }

        if (message.success === false || message.error) {
          callbacks.onError(message.error ?? message.message ?? 'A fonte BTC/USD recusou a inscrição.');
          return;
        }

        const point = parseKrakenTickerMessage(rawMessage);
        if (!point) return;
        retryAttempt = 0;
        callbacks.onStatus('CONECTADO');
        callbacks.onPrice(point);
      };

      nextSocket.onerror = () => {
        if (!stopped && socket === nextSocket) {
          callbacks.onError('A conexão com a fonte pública BTC/USD foi interrompida. Tentando reconectar.');
        }
      };

      nextSocket.onclose = () => {
        if (socket === nextSocket) socket = null;
        scheduleReconnect();
      };
    } catch {
      callbacks.onError('Não foi possível abrir a conexão pública BTC/USD. Tentando reconectar.');
      scheduleReconnect();
    }
  };

  openSocket();

  return {
    close: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      const activeSocket = socket;
      socket = null;
      if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
        activeSocket.close();
      }
    },
  };
}