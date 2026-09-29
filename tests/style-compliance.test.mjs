/**
 * Style compliance for styles.css.
 *
 * These two rules are cheap to check and both regressed silently before: a
 * stylesheet with a dead `--tm-*` token or a `transition: all` still builds,
 * still renders, and only shows up as sluggish hover or a drifting token set
 * months later.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(pluginRoot, "styles.css"), "utf-8");

test("styles.css: no `transition: all`", async (t) => {
  await t.test("every transition names its properties", () => {
    // Obsidian's own style guidance rules `all` out: it animates whatever
    // happens to change (including properties a user's theme adds) and costs a
    // style recalc per attribute change. Interactive surfaces use
    // --tm-transition-ui instead.
    const offenders = [];
    css.split("\n").forEach((line, i) => {
      // Ignore prose — the rule is explained in a comment near --tm-transition-ui.
      if (/^\s*(\/\*|\*)/.test(line)) return;
      if (/transition:\s*all\b/.test(line)) offenders.push(`L${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `transition: all found:\n${offenders.join("\n")}`);
    assert.match(css, /--tm-transition-ui:/);
  });
});

test("styles.css: every --tm-* token is defined once and used", async (t) => {
  await t.test("no duplicate definitions", () => {
    const defRe = /^\s*(--tm-[a-z0-9-]+)\s*:/gm;
    const counts = new Map();
    for (const m of css.matchAll(defRe)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const dupes = [...counts].filter(([, n]) => n > 1).map(([name, n]) => `${name} ×${n}`);
    assert.deepEqual(dupes, [], `duplicate --tm-* definitions:\n${dupes.join("\n")}`);
  });

  await t.test("no dead tokens", () => {
    // A token nothing consumes is either a leftover from a refactor or a typo
    // in the definition itself — both worth failing on. Tokens a user may set
    // from a snippet are consumed through var(--x, fallback) and therefore
    // still count as used.
    const defined = [...css.matchAll(/^\s*(--tm-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
    const dead = defined.filter((name) => {
      const uses = [...css.matchAll(new RegExp(`var\\(\\s*${name}\\s*[,)]`, "g"))].length;
      return uses === 0;
    });
    assert.deepEqual(dead, [], `unreferenced --tm-* tokens:\n${dead.join("\n")}`);
  });
});

test("styles.css: custom properties stay inside a rule block", async (t) => {
  await t.test("no orphaned --tm-* tokens at top level", () => {
    // A token written after a rule's closing `}` is dead CSS: browsers drop it,
    // so every var() consumer silently falls back. This class of bug shipped
    // once when a design-token block was split and the closing brace moved.
    const offenders = [];
    let depth = 0;
    css.split("\n").forEach((line, i) => {
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      const s = line.trim();
      // Skip comment chrome (box-drawing separators inside block comments).
      if (/^(\/\*|\*|\/\/)/.test(s) || /^-{3,}$/.test(s)) return;
      if (depth === 0 && s.startsWith("--")) {
        offenders.push(`L${i + 1}: ${s.slice(0, 80)}`);
      }
      if (depth < 0) {
        offenders.push(`L${i + 1}: unbalanced '}'`);
        depth = 0;
      }
    });
    assert.deepEqual(offenders, [], `orphaned tokens / unbalanced braces:\n${offenders.join("\n")}`);
  });
});

test("styles.css: accent-colored text uses Obsidian's text accent", async (t) => {
  await t.test("no text painted with the control accent", () => {
    // Obsidian maintains two accents and the split is deliberate:
    // --interactive-accent is the *control* accent (fills, focus borders,
    // underlines) and themes are not obliged to keep it readable as body text;
    // --text-accent is the *readable* accent themes tune for contrast. Painting
    // text with the control accent is why plugins go unreadable on a deep or
    // neon theme accent, so text routes through --tm-text-accent instead.
    // Border and background declarations may still use --interactive-accent.
    const offenders = [];
    css.split("\n").forEach((line, i) => {
      if (/^\s*(\/\*|\*)/.test(line)) return;
      if (/(?<![\w-])color:\s*var\(--interactive-accent\)/.test(line)) {
        offenders.push(`L${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], `text using the control accent:\n${offenders.join("\n")}`);
    assert.match(css, /--tm-text-accent:\s*var\(--text-accent/);
  });
});

test("styles.css: type sizes resolve through Obsidian / --tm-type tokens", async (t) => {
  await t.test("no bare font-size px values", () => {
    // Plugin guidelines: respect the user's font-size settings. A hardcoded
    // px type ramp freezes the UI when the user scales interface fonts.
    // The only allowed literals live on --tm-type-* definitions (and those
    // must themselves derive from --font-ui-*).
    const offenders = [];
    css.split("\n").forEach((line, i) => {
      if (/^\s*(\/\*|\*)/.test(line)) return;
      if (/\bfont-size:\s*[0-9.]+px/.test(line)) {
        offenders.push(`L${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepEqual(offenders, [], `hardcoded font-size px:\n${offenders.join("\n")}`);
    assert.match(css, /--tm-type-body:\s*var\(--font-ui-/);
  });
});

test("styles.css: no hardcoded colors", async (t) => {
  await t.test("every color resolves through an Obsidian or --tm-* variable", () => {
    // The plugin ships into arbitrary user themes. A literal hex or rgb() is a
    // color that cannot adapt to light/dark and that no theme can override.
    const offenders = [];
    css.split("\n").forEach((line, i) => {
      if (/^\s*(\/\*|\*)/.test(line)) return;
      const literals = line.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g);
      if (literals) offenders.push(`L${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [], `hardcoded colors:\n${offenders.join("\n")}`);
  });
});

test("styles.css: host surface steps, no !important outside HOST OVERRIDE, no multicolumn gap", () => {
  // The HOST OVERRIDE section is the force-win layer against host/theme CSS
  // and uses !important on purpose. The design-system body must stay clean.
  const marker = "HOST OVERRIDE — leaf-scoped force-win layer";
  const body = css.includes(marker) ? css.slice(0, css.indexOf(marker)) : css;
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /!important/);
  assert.doesNotMatch(code, /\bcolumn-gap\s*:/);
  assert.doesNotMatch(code, /\brow-gap\s*:/);
  assert.match(css, /--tm-bg-page:\s*var\(--background-secondary\)/);
  assert.match(css, /--tm-bg-card:\s*var\(--background-primary\)/);
  assert.match(css, /--tm-bg-chrome:\s*var\(--background-secondary-alt/);
  assert.match(css, /font-family:\s*var\(--font-interface\)/);
  assert.match(css, /--tm-lh-body:\s*var\(--line-height-normal/);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/);
});

test("selected controls have no side or bottom accent bar; suggestion kind borders stay", () => {
  const blocks = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css))) blocks.push({ selector: match[1], body: match[2] });
  const selectedSel = /data-active|tm-tab-active|\.active\b|is-selected/;
  const strip = /inset\s+[1-9]\d*px\s+0\s+0\s+0|inset\s+0\s+-[1-9]\d*px\s+0\s+0|border-(?:left|bottom)\s*:\s*[1-9]\d*px[^;]*(?:accent|interactive)/;
  const offenders = blocks
    .filter((b) => selectedSel.test(b.selector) && strip.test(b.body))
    .map((b) => b.selector.trim().replace(/\s+/g, " ").slice(0, 100));
  assert.deepEqual(offenders, []);
  assert.match(css, /\.tm-suggestion-card\.tm-suggestion-create-topic[\s\S]{0,240}border-left-color:/);
  assert.match(css, /\.tm-suggestion-card\.tm-suggestion-stale-topic[\s\S]{0,160}border-left-color:/);
  assert.match(css, /\.tm-pending-write-card\s*\{[^}]*border-left-color:/);
});

test("DESIGN.md token values match styles.css", async (t) => {
  // The design doc is the IA truth; styles.css is the numeric truth. They
  // drifted once (radius 4/6/10 documented vs 4/8/14 shipped) — lock them.
  const design = fs.readFileSync(path.join(pluginRoot, "DESIGN.md"), "utf8");
  const radius = {
    sm: css.match(/--tm-radius-sm:\s*(\d+)px/)?.[1],
    ctl: css.match(/--tm-radius-ctl:\s*(\d+)px/)?.[1],
    card: css.match(/--tm-radius-card:\s*(\d+)px/)?.[1],
  };
  assert.ok(radius.sm && radius.ctl && radius.card, "radius tokens missing in styles.css");
  // DESIGN table row: `4 / 8 / 14 / 999 px`
  assert.match(
    design,
    new RegExp(`${radius.sm}\\s*/\\s*${radius.ctl}\\s*/\\s*${radius.card}\\s*/\\s*999`),
    "DESIGN radius row must match styles.css values",
  );
  const displayFactor = css.match(/--tm-type-display:\s*calc\(var\(--font-ui-medium\)\s*\*\s*([\d.]+)\)/)?.[1];
  if (displayFactor) {
    assert.match(
      design,
      new RegExp(`--font-ui-medium\\s*\\*\\s*${displayFactor.replace(".", "\\.")}`),
      "DESIGN type-display factor must match styles.css",
    );
  }
});

test("src/: no JS CSS injection — styles.css is the only channel", () => {
  // Community plugin review ERROR: creating/attaching <style> elements OR
  // injecting CSSStyleSheet via document.adoptedStyleSheets is not allowed.
  // Obsidian loads styles.css — that file is the only styling channel.
  // Ad-hoc `!important` / surface-lock stay banned in src.
  const srcDir = path.join(pluginRoot, "src");
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(ent.name)) {
        const text = fs.readFileSync(p, "utf8");
        text.split("\n").forEach((line, i) => {
          if (/^\s*(\/\*|\*|\/\/)/.test(line)) return;
          if (/!important/.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: !important → ${line.trim().slice(0, 100)}`);
          }
          if (/surface-lock/.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: surface-lock`);
          }
          if (/createElement\(\s*["']style["']\s*\)/.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: createElement("style")`);
          }
          if (/document\.(head|body)\.appendChild/.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: document.*.appendChild`);
          }
          if (/adoptedStyleSheets/.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: adoptedStyleSheets injection`);
          }
          if (/replaceSync\s*\(/.test(line) && /CSSStyleSheet|sheet/i.test(line)) {
            offenders.push(`${path.relative(pluginRoot, p)}:${i + 1}: CSSStyleSheet.replaceSync injection`);
          }
        });
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `forbidden style injection found:\n${offenders.join("\n")}`);
  const main = fs.readFileSync(path.join(srcDir, "main.ts"), "utf8");
  assert.doesNotMatch(main, /HOST_OVERRIDE_CSS|adoptedStyleSheets|ensureHostStyles/);
});

test("styles.css HOST OVERRIDE stays leaf-scoped (no core chrome hiding)", () => {
  // Community review: do not hide app-wide chrome. Hiding .view-header is
  // allowed ONLY on topmind product leaves (duplicate of tm-toolbar /
  // tm-tab-bar). A bare `.view-header { display:none }` is forbidden.
  const hideBlocks = [...css.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)];
  const bare = hideBlocks
    .map((m) => m[1].trim())
    .filter((sel) => /(^|,)\s*\.view-header\s*$/.test(sel) || sel === ".view-header");
  assert.deepEqual(bare, [], "styles.css must not hide .view-header globally");
  // Product-leaf hide must be present (product owns the top band).
  assert.match(
    css,
    /\.workspace-leaf-content\[data-type\^="topmind-"\]\s+\.view-header\s*\{[^}]*display:\s*none/,
    "topmind leaves must hide the duplicate native view-header",
  );
  const marker = "HOST OVERRIDE — leaf-scoped force-win layer";
  assert.ok(css.includes(marker), "styles.css must contain the HOST OVERRIDE section");
});

test("styles.css: pill radius only on tag/status/filter/tool-chip", () => {
  // UI/UX 2.0 §18: 999px is a semantic pill, not a default radius for nav/chips.
  const blocks = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(css))) blocks.push({ selector: match[1].trim().replace(/\s+/g, " "), body: match[2] });
  const allowed = /tm-card-tag|tm-impact|tm-suggestion-count-badge|tm-chat-tool-chip|tm-radius-pill|status|badge|chip|tag|filter|tm-dot-/i;
  const offenders = blocks
    .filter((b) => /border-radius:\s*var\(--tm-radius-pill\)/.test(b.body) && !allowed.test(b.selector))
    .map((b) => b.selector.slice(0, 100));
  assert.deepEqual(offenders, [], `pill radius on non-semantic controls:\n${offenders.join("\n")}`);
});

test("chat input pins to sidebar bottom (flex chain)", () => {
  assert.match(css, /\.tm-tab-content\.tm-chat-container\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.tm-tab-content\.tm-chat-container\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.tm-tab-content\.tm-chat-container\s*>\s*\.tm-chat-messages\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /\.tm-tab-content\.tm-chat-container\s*>\s*\.tm-chat-input-area\s*\{[^}]*margin-top:\s*auto/s);
  assert.match(css, /topmind-sidebar-dock"\]\s+\.tm-sidebar-dock\s*\{[^}]*flex:\s*1 1 auto/s);
  assert.match(css, /topmind-sidebar-dock"\]\s+\.view-content\s*\{[^}]*display:\s*flex/s);
});

test("styles.css parses: no broken escapes or literal \\n artifacts", () => {
  // Regression: extracting CSS from TS string literals mangled `data-type=\"…\"`
  // into `data-type=\\` + line break + `]`, and left a literal `\\n` line.
  // That made the community CSS linter report "Unknown word \\n" and the host
  // CSS parser drop the sheet (missing backgrounds).
  const problems = [];
  css.split("\n").forEach((line, i) => {
    if (/\\$/.test(line.trimEnd()) && !/\\["']/.test(line)) {
      // trailing lone backslash (line-continuation artifact)
      if (!line.includes("data-type=") || !line.includes('"')) {
        problems.push(`L${i + 1}: trailing backslash: ${line.trim().slice(0, 80)}`);
      }
    }
    if (line.trim() === "\\n") {
      problems.push(`L${i + 1}: literal \\n artifact`);
    }
    if (/data-type=\\$/.test(line.trimEnd())) {
      problems.push(`L${i + 1}: broken data-type=\\ escape: ${line.trim().slice(0, 80)}`);
    }
  });
  assert.deepEqual(problems, [], `styles.css syntax artifacts:\n${problems.join("\n")}`);
  // brace balance
  assert.equal(css.split("{").length, css.split("}").length, "styles.css braces unbalanced");
});

test("composer clears the native status bar; tab content has side inset", () => {
  assert.match(css, /--tm-status-bar-clearance:\s*28px/);
  assert.match(css, /\.tm-chat-input-area\s*\{[^}]*padding-bottom:\s*var\(--tm-status-bar-clearance\)/s);
  assert.match(css, /\.tm-tab-content\s*\{[^}]*padding:\s*var\(--tm-gap-md\)/s);
});
