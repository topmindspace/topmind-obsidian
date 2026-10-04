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
- `styles.css` is the **only** CSS channel (community review). No JS style injection (`<style>`, `adoptedStyleSheets`, `CSSStyleSheet.replaceSync`). No `!important`. Do not hide Obsidian app chrome. Topmind leaves may hide their own duplicate `.view-header` with a leaf-scoped selector.
- Desktop-only Node builtins (`fs`/`path`/`crypto`) stay behind `isDesktopOnly` and the vault path helpers. Do not scan the home directory. Desktop key import reads only the file the user picks. All AI writes go through `resolveInsideVault` / Kernel `executeWrite`.
- User-facing strings go through `src/i18n` (`zh-CN.ts` is the type source; `en-US.ts` must stay key-identical).
- Destructive UI actions (clear history, new chat, clear todos) require `ConfirmModal` from `src/views/confirm-modal.ts`.

## Releases

Tag `X.Y.Z` (no `v` prefix) — the tag must equal `manifest.version` exactly. CI builds the vendored plugin first, then uploads only `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` and attaches attestations. Do not attach a zip or `versions.json` to the GitHub Release. `npm run pack` is a local zip for manual installs.
