---
name: Android capture boundary
description: The platform constraint that shapes the BTC analyzer's capture implementation.
---

MediaProjection screen capture and its Android foreground service must be implemented in a native Android build. Expo Go cannot register that bridge, so the app must expose an explicit unsupported state rather than simulate permission or frames.

**Why:** Faking screen capture would mislead the user and violate Android's protected capture flow.

**How to apply:** Keep the analyzer and UI independent from the capture bridge. Replace the screen-capture boundary only when a native Android build/module is added, retaining the official MediaProjection permission flow and temporary-frame handling.