---
name: Expo preview dependency links
description: A Replit mobile artifact can lose its runnable Expo CLI when workspace installs leave artifact-local pnpm links pointing at removed virtual-store paths.
---

When a mobile artifact workflow cannot start Expo, verify that the artifact-local `node_modules/expo` symlink resolves to an existing CLI before changing artifact routing or Expo configuration. A frozen workspace install can restore the links without changing the declared project configuration.

**Why:** In this workspace, the preview workflow returned 502 because the Expo link inside the artifact pointed to a removed pnpm virtual-store target after workspace dependencies changed; restoring links made `/status` and the browser route respond normally.

**How to apply:** For an Expo artifact 502, compare the workflow’s configured port and `/status` with the CLI link target. Repair package links from the frozen lockfile first; change the workflow only if the server still fails after it starts cleanly.