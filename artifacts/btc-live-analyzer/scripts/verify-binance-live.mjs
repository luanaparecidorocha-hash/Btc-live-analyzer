// Manual real-network check; never injects synthetic data into the application.
// Run: node --experimental-strip-types scripts/verify-binance-live.mjs
import assert from 'node:assert/strict';
import { createBinanceMarketFeed } from '../lib/binanceMarketData.ts';

const feed = createBinanceMarketFeed();
let timeout;
let unsubscribe;
try {
  const samples = await new Promise((resolve, reject) => {
    const observations = [];
    let lastEventTime = null;
    timeout = setTimeout(() => reject(Error(
      `No 5 live BTCUSDT updates within 30s: ${JSON.stringify(feed.getSnapshot())}`,
    )), 30000);
    unsubscribe = feed.subscribe(() => {
      const state = feed.getSnapshot();
      if (state.status !== 'CONECTADO' || !state.latest || state.latest.eventTime === lastEventTime) return;
      const quote = state.latest;
      assert.equal(quote.symbol, 'BTCUSDT');
      assert.equal(quote.quoteCurrency, 'USDT');
      assert.ok(quote.price > 0 && Number.isFinite(quote.price));
      assert.ok(Math.abs(quote.receivedAt - quote.eventTime) < 30000, 'Exchange event is not recent');
      lastEventTime = quote.eventTime;
      observations.push(quote);
      if (observations.length === 5) resolve(observations);
    });
    feed.start();
  });
  console.log(JSON.stringify({ verified: true, samples, state: feed.getSnapshot() }, null, 2));
} finally {
  clearTimeout(timeout);
  unsubscribe?.();
  feed.stop();
}
