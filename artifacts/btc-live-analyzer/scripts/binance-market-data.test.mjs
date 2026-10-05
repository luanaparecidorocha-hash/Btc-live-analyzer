import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBinanceMarketFeed, parseBinanceMiniTicker, BINANCE_BTC_USDT_URL } from '../lib/binanceMarketData.ts';

const ticker = (overrides = {}) => JSON.stringify({
  e: '24hrMiniTicker', E: 1700000000000, s: 'BTCUSDT', c: '65000.12', ...overrides,
});

test('parses only genuine BTCUSDT last-price observations with separate timestamps', () => {
  assert.deepEqual(parseBinanceMiniTicker(ticker(), 1700000000500), {
    source: 'BINANCE', symbol: 'BTCUSDT', quoteCurrency: 'USDT',
    price: 65000.12, eventTime: 1700000000000, receivedAt: 1700000000500,
  });
  for (const raw of ['null', '[]', '{}', '{', ticker({ s: 'BTCUSD' }),
    ticker({ e: 'trade' }), ticker({ c: '' }), ticker({ c: null }),
    ticker({ c: '-1' }), ticker({ c: 'NaN' }), ticker({ c: 'Infinity' }),
    ticker({ E: null }), ticker({ E: -1 }), ticker({ E: 1.5 })]) {
    assert.equal(parseBinanceMiniTicker(raw), null, raw);
  }
});

test('isolated lifecycle, real-data readiness, bounded storage, retries and cleanup', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000010000 });
  const sockets = [];
  class FakeSocket {
    readyState = 1;
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.readyState = 3; }
    emit(raw) { this.onmessage?.({ data: raw }); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  const feed = createBinanceMarketFeed();
  t.after(() => { feed.stop(); globalThis.WebSocket = original; });
  let notifications = 0;
  const unsubscribe = feed.subscribe(() => notifications++);
  feed.start();
  feed.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, BINANCE_BTC_USDT_URL);
  assert.equal(feed.getSnapshot().status, 'CONECTANDO');
  sockets[0].emit(ticker({ s: 'ETHUSDT' }));
  assert.equal(feed.getSnapshot().latest, null);
  for (let i = 0; i < 670; i++) sockets[0].emit(ticker({ E: 1700000000000 + i }));
  const filled = feed.getSnapshot();
  assert.equal(filled.status, 'CONECTADO');
  assert.equal(filled.receivedCount, 670);
  assert.equal(filled.recentQuotes.length, 660);
  assert.ok(Object.isFrozen(filled.recentQuotes));
  sockets[0].emit(ticker()); // Old event.
  assert.equal(feed.getSnapshot(), filled);
  const lateHandler = sockets[0].onmessage;
  sockets[0].onerror();
  assert.equal(feed.getSnapshot().status, 'RECONECTANDO');
  assert.ok(feed.getSnapshot().error);
  assert.equal(feed.getSnapshot().latest, filled.latest); // Last known, not connected/live.
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
  lateHandler({ data: ticker({ E: 1700000000900 }) });
  assert.equal(feed.getSnapshot().receivedCount, 670);
  sockets[1].emit(ticker({ E: 1700000001000 }));
  assert.equal(feed.getSnapshot().status, 'CONECTADO');
  assert.equal(feed.getSnapshot().error, null);
  t.mock.timers.tick(45000);
  assert.equal(feed.getSnapshot().status, 'RECONECTANDO');
  feed.stop();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 2);
  assert.equal(feed.getSnapshot().status, 'DESATIVADA');
  assert.ok(notifications > 0);
  unsubscribe();
  feed.start();
  assert.equal(sockets.length, 3);
  feed.stop();
});

test('failed socket creation backs off rather than interfering with other feeds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.WebSocket;
  let attempts = 0;
  globalThis.WebSocket = class { constructor() { attempts++; throw Error('offline'); } };
  const feed = createBinanceMarketFeed();
  t.after(() => { feed.stop(); globalThis.WebSocket = original; });
  feed.start();
  assert.equal(feed.getSnapshot().status, 'RECONECTANDO');
  t.mock.timers.tick(1000);
  assert.equal(attempts, 2);
  t.mock.timers.tick(1999);
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  assert.equal(attempts, 3);
  feed.stop();
  t.mock.timers.tick(60000);
  assert.equal(attempts, 3);
});
