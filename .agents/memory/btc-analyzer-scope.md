---
name: BTC analyzer scope
description: Standing product constraints for the BTC Live Analyzer.
---

The BTC Live Analyzer is informational only: it must never execute buy or sell orders. Market-price analysis and optional screen-capture data must remain separate. Preserve the existing native screen-capture feature and all Expo/EAS configuration unless the user explicitly asks to change them.

An analysis run starts with its first live BTC/USD quote and ends exactly five minutes later. Freeze the collected window and final result at that deadline; do not automatically start another run.

**Why:** The user set the app's informational constraints and specified that the five-minute collection must be finalized once without auto-restarting.

**How to apply:** Anchor the deadline to the first live quote, reject later samples, freeze the final analysis, and preserve the capture permission/region flow and Expo/EAS setup.