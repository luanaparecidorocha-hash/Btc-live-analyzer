---
name: BTC analyzer scope
description: Standing product constraints for the BTC Live Analyzer.
---

The BTC Live Analyzer is informational only: it must never execute buy or sell orders. Market-price analysis and optional screen-capture data must remain separate. Preserve the existing native screen-capture feature and all Expo/EAS configuration unless the user explicitly asks to change them.

**Why:** The user set these as standing constraints for this product; adding public market data does not authorize trade execution or a platform-configuration migration.

**How to apply:** Keep order execution out of the app, derive signals from real BTC/USD prices, and preserve the capture permission/region flow and Expo/EAS setup in future changes.