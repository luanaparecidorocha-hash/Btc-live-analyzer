---
name: EAS pnpm validation
description: Why a successful workspace dependency installation may not prove EAS compatibility.
---

Validate dependency-script approval changes against the pnpm version reported by the EAS builder, as well as the workspace default when relevant.

**Why:** The workspace's pnpm 10 accepted an existing approval list, while EAS's pnpm 11 ignored the removed `onlyBuiltDependencies` setting and rejected an unreviewed build script. A frozen-lockfile installation can pass locally without establishing compatibility with the builder's policy.

**How to apply:** Check version-specific approval settings before diagnosing a lockfile mismatch. Use an isolated temporary copy for a clean install with the builder's version so the running workspace's dependencies and toolchain are not replaced.