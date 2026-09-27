# Contributing to Topmind Stream

Thanks for helping improve the Obsidian plugin.

## Development

```bash
# Kernel engine is vendored from ../topmind (or TOPMIND_SRC / CI .topmind-src)
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

- Keep `manifest.json` / `versions.json` in sync (`versions[manifest.version] = minAppVersion`).
- Run `npm run typecheck` and `npm test` before pushing — `tests/obsidian-guideline-compliance.test.mjs` and `tests/style-compliance.test.mjs` lock Obsidian plugin guidelines and the design tokens.
- Prefer Obsidian CSS variables and the `--tm-*` tokens in `styles.css`; do not hardcode colors or font sizes.
- Desktop-only Node builtins (`fs`/`path`/`os`/`crypto`) stay behind `isDesktopOnly` and the vault path helpers — never touch files outside the vault except the documented Desktop key-import paths.

## Releases

Tag `X.Y.Z` (no `v` prefix). CI builds a vendored zip, attaches GitHub artifact attestations, and updates the community release.
