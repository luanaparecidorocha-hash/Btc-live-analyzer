---
name: BTC analyzer scope
description: Standing product constraints for the BTC Live Analyzer.
---

The BTC Live Analyzer is informational only: it must never execute buy or sell orders. Market-price analysis and optional screen-capture data must remain separate. Preserve the existing native screen-capture feature and all Expo/EAS configuration unless the user explicitly asks to change them.

Continuous analysis starts with its first live BTC/USD quote. Each window lasts exactly five minutes from its first new live quote; freeze and evaluate it once, save its result, then automatically collect the next window on the same connection until the user presses PARAR. Show each completed result inside the app, including AGUARDAR.

On a temporary disconnect, preserve completed history and discard only the incomplete window. Resume a fresh five-minute window from the first quote after reconnection.

**Why:** The user replaced manual restarts with continuous cycles and required safe reconnection without erasing history or changing the engine. The engine requires five minutes from the first observed quote; anchoring to a boundary before that quote would make later cycles incomplete. Never invent boundary samples or reuse old prices.

Signals must consider price direction/variation, movement strength, and trend consistency. Conflicting or insufficient evidence must yield AGUARDAR. Confirmation is signal strength, not a probability or guarantee of success.

Trend describes predominant price direction independently of the stronger trade-signal thresholds: a sustained small decline can be BAIXA with AGUARDAR. Every completed analysis, including AGUARDAR, must remain in persistent history below the current analysis; new runs must never erase earlier results.

Internal engine tests must be separate, disabled by default and visibly simulated. They must use the same decision engine as real prices without changing Kraken, capture, live history, the real five-minute window, Expo or EAS.

**Why:** The user set these informational and isolation constraints and repeatedly required preserving the tested decision engine, real Kraken source, persistent history and Expo/EAS configuration.

**How to apply:** Anchor each window to its first new live quote and assign boundary quotes only to the next cycle. Freeze each completed window and preserve capture permissions, region settings and Expo/EAS setup. Keep synthetic inputs and results outside live collection and persistence; never duplicate decision logic.

When investigating recognition of an Expo authorization already granted in the browser, do not request a new OAuth authorization. Limit recovery to the existing Replit integration; do not change BTC Live Analyzer code or Expo/EAS configuration.

**Why:** The user repeatedly required preserving the existing authorization and isolating connection recovery from app changes.

**How to apply:** Look for an existing connection that can be attached. If recovery is unavailable, distinguish observed connection state from an unverified callback or permission failure; do not substitute another OAuth flow.

Binance is a second, public-market-data source for BTC/USDT, not a replacement for Kraken BTC/USD. Do not request API keys, passwords or account credentials for it. In the initial integration stage, collect observations independently for future comparison: no multiple-exchange screen and no changes to the existing signals, five-minute cycle or capture.

**Why:** The user explicitly required an isolated first stage and preservation of everything already working. The quote currencies differ: BTC/USDT must not be treated as BTC/USD or silently fed into the current engine.

**How to apply:** Keep Binance observations separate from Kraken-driven analysis. Only expand comparison, UI or signal use when explicitly requested, and keep the source and quote currency distinct.