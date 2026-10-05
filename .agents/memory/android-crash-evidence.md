---
name: Android crash evidence
description: Do not equate bridge defects or successful builds with a confirmed cause of Android process termination.
---

Attribute an abrupt Android process termination to a file/line only after obtaining device runtime evidence: AndroidRuntime/FATAL EXCEPTION, a native tombstone/backtrace, or ApplicationExitInfo. EAS build logs describe compilation and do not contain the installed phone's crash.

**Why:** A confirmed unsupported Expo bridge return and guarded foreground-service startup passed isolated Kotlin checks and an APK build, but the user reported that the installed app still terminated, even before starting analysis. Those defects were not sufficient evidence of its fatal cause.

**How to apply:** Separate supported return-type defects, lifecycle risks and dependency warnings from the observed fatal stack. Capture the existing APK before speculative changes or rebuilds. Include startup without tapping INICIAR, and capture native signals/exit reasons as well as Java exceptions. Do not PID-filter live logcat across crashes, because restarts change the PID.
