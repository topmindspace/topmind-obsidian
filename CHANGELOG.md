# Changelog

## 4.17.0 — Quality, community compliance, and maintainability

### Community / security
- **AI key vault backup is opt-in** (default off). Secrets no longer land in `.topmind/ai-keys-backup.json` unless you enable it under Settings → Security.
- **`styles.css` is the only CSS channel.** Removed `adoptedStyleSheets` / `host-override.ts` JS style injection.
- **Native `view-header` stays visible** (back/forward + title). Product chrome lives in `tm-*` toolbars below it.
- AI write paths resolve through `resolveInsideVault` before any `mkdir`/`write`.

### Reliability
- AI task lane: `inFlight` gate keeps the queue strictly serial after abort.
- Plugin unload resets `aiTaskManager`, pending-writes workspace, and `BACKUP_KEEP` / `RECEIPT_KEEP` env overrides.
- Memory browse cache is capped and cleared on close.
- Destructive actions (new chat / clear history / clear todos) require confirm.

### UI / UX
- Token ladder aligned with DESIGN (`hit 36/32/42`, `radius 4/10/16/999`).
- Status chips use distinct tints; card actions reveal on `:focus-within`.
- Sidebar tabs are keyboard-navigable (arrows / Home / End).
- Locale switch re-registers command names (no boot-locale freeze).
- Settings: accurate test-connection / model descriptions; template labels localized.

### Maintainability
- `plugin.test.mjs` split into focused suites + `tests/helpers.mjs`.
- Shared `view-openers.ts` / `confirm-modal.ts` remove duplicated open/confirm logic.
- HOST OVERRIDE merged (last-wins) — no self-conflicting force-win rules.
- Dead CSS selectors removed.

## 4.16.16 and earlier

See git history.
