---
"@glrs-dev/harness-opencode": patch
---

Fix OpenCode startup crash caused by unrecognized `harness` top-level key in opencode.json. Move plugin config (model tiers, toolHooks) into the SDK plugin options tuple form. Auto-migrate legacy config on install. Replace readline number-input prompts with @inquirer/prompts (arrow-key select, checkbox, confirm). Fix plugin detection to handle tuple entries in install/uninstall/doctor.
