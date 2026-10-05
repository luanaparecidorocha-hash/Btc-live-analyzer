---
name: GitHub build source synchronization
description: A working GitHub connector does not guarantee shell Git push authentication; preserve exact source when preparing remote Android builds.
---

If shell Git push rejects authentication, use the already-authorized GitHub connector proxy rather than extracting credentials or assuming the integration needs reconnecting.

**Why:** Shell Git authentication failed while the existing GitHub connector could read and write the same repository. A remote build would otherwise use older code, missing the new diagnostics.

**How to apply:** Verify the remote build reference contains the intended local snapshot before triggering EAS. If using Git database APIs to synchronize existing commits, preserve author/committer metadata, parent chains and file modes; verify blob/tree/commit hashes and update the branch only as a non-forced fast-forward. Stop if the remote branch changes unexpectedly.
