---
name: Expo MCP build directory
description: Avoid relying on saved EAS base-directory settings when requesting monorepo builds through MCP.
---

Pass the repository-relative application directory explicitly in Expo MCP build requests for this monorepo.

**Why:** A request omitting the optional base directory tried to read `/eas.json`, although the user had reported saving the application's subdirectory in EAS. Do not assume the saved dashboard value is inherited by the MCP request.

**How to apply:** Supply the base-directory request parameter without changing project files or dashboard settings. If a write returns a gateway error, check the build list before retrying because a lost response does not prove that no build was created.