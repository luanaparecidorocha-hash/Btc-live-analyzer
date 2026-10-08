import assert from 'node:assert/strict';
import test from 'node:test';
import { connectBtcUsdTicker, parseKrakenOhlcMessage } from '../lib/marketData.ts';

function krakenOhlc(overrides = {}) {
  return JSON.stringify({
    channel: 'ohlc',
    type: 'update',
    data: [{
      symbol: 'BTC/USD',
      interval: 1,
      interval_begin: '2024-01-01T00:00:00.000000000Z',
      open: '42000.0',
      high: '42100.0',
      low: '41900.0',
      close: '42050.0',
      ...overrides,
    }],
  });
}

test('parses real Kraken one-minute OHLC values and timestamps', () => {
  assert.deepEqual(parseKrakenOhlcMessage(krakenOhlc()), {
    timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
    open: 42000, high: 42100, low: 41900, close: 42050,
  });
});

test('rejects other Kraken messages, pairs, intervals and invalid OHLC ranges', () => {
  assert.equal(parseKrakenOhlcMessage('{'), null);
  assert.equal(parseKrakenOhlcMessage(JSON.stringify({ channel: 'ticker', data: [] })), null);
  assert.equal(parseKrakenOhlcMessage(krakenOhlc({ symbol: 'ETH/USD' })), null);
  assert.equal(parseKrakenOhlcMessage(krakenOhlc({ interval: 5 })), null);
  assert.equal(parseKrakenOhlcMessage(krakenOhlc({ high: '42010', close: '42050' })), null);
  assert.equal(parseKrakenOhlcMessage(krakenOhlc({ open: '0' })), null);
});

test('Kraken connection keeps its ticker subscription and adds real one-minute OHLC delivery', () => {
  const original = globalThis.WebSocket;
  const sockets = [];
  globalThis.WebSocket = class {
    static CLOSING = 2;
    readyState = 0;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  };
  const candles = [];
  let connection;
  try {
    connection = connectBtcUsdTicker({
      onPrice() {},
      onCandle: (candle) => candles.push(candle),
      onStatus() {},
      onError() {},
    });
    const socket = sockets[0];
    socket.readyState = 1;
    socket.onopen();
    assert.deepEqual(socket.sent.map((message) => message.params.channel), ['ticker', 'ohlc']);
    assert.deepEqual(socket.sent[1].params.symbol, ['BTC/USD']);
    assert.equal(socket.sent[1].params.interval, 1);
    socket.onmessage({ data: krakenOhlc() });
    assert.deepEqual(candles, [parseKrakenOhlcMessage(krakenOhlc())]);
  } finally {
    connection?.close();
    globalThis.WebSocket = original;
  }
});
