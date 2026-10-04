---
name: Android background limits
description: Foreground-service limits and why Android background claims require native-device evidence.
---

Treat continuous market fetching as data synchronization, with Android's time
and battery limits. Do not use MediaProjection, location, or specialUse just to
avoid those limits. Screen capture is a separate feature, not an exemption that
keeps all analysis alive indefinitely.

**Why:** The requested background behavior is explicitly subject to Android
limits. Android 15+ restricts current-target dataSync foreground services to an
aggregate six background hours per 24-hour period. A foreground-service
notification alone also does not establish that React Native JS timers remain
active; runtime ownership and Android lifecycle behavior must be verified.

**How to apply:** Preserve the existing signal engine and treat background work
as execution/lifecycle ownership only. Explain timeout, force-stop, network and
manufacturer battery restrictions. Separate bundle/autolinking/unit/web checks
from an APK build and real-device checks of minimization, screen locking,
notifications, stopping and reopening. Never describe Expo Go or browser tests
as proof of Android background execution.