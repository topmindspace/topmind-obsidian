# Contributing to Topmind Stream

Thanks for helping improve the Obsidian plugin.

## Development

```bash
# Kernel engine is vendored from ../topmind (or TOPMIND_SRC / CI .topmind-src)
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run pack:verify
```

Run a single suite:

```bash
node --experimental-strip-types --test tests/style-compliance.test.mjs
node --experimental-strip-types --test tests/stream-utils.test.mjs
```

Suites are split by concern (`i18n-locale`, `ui-chrome`, `stream-utils`, `settings-model`, `ai-chat-hygiene`, `build-writepath`, plus kernel/style/guideline packs). Shared helpers live in `tests/helpers.mjs`.

## Pull requests

- Keep `manifest.json` / `versions.json` / `package.json` versions in sync (`versions[manifest.version] = minAppVersion`).
- Run `npm run typecheck`, `npm run lint`, and `npm test` before pushing — `tests/obsidian-guideline-compliance.test.mjs` and `tests/style-compliance.test.mjs` lock Obsidian plugin guidelines and the design tokens.
- Prefer Obsidian CSS variables and the `--tm-*` tokens in `styles.css`; do not hardcode colors or font sizes. Token values live only in `styles.css` `:root` (DESIGN.md documents the ladder).
- `styles.css` is the **only** CSS channel (community review). No JS style injection (`<style>`, `adoptedStyleSheets`, `CSSStyleSheet.replaceSync`). Do not hide Obsidian core chrome (`.view-header` must stay visible).
- Desktop-only Node builtins (`fs`/`path`/`os`/`crypto`) stay behind `isDesktopOnly` and the vault path helpers — never touch files outside the vault except the documented Desktop key-import paths. All AI writes go through `resolveInsideVault` / Kernel `executeWrite`.
- User-facing strings go through `src/i18n` (`zh-CN.ts` is the type source; `en-US.ts` must stay key-identical).
- Destructive UI actions (clear history, new chat, clear todos) require `ConfirmModal` from `src/views/confirm-modal.ts`.

## Releases

Tag `X.Y.Z` (no `v` prefix) — the tag must equal `manifest.version` exactly. CI builds a vendored zip, attaches GitHub artifact attestations, and updates the community release.
