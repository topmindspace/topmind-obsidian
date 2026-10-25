// Compare actual community assets across independent builds and checkout paths.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = ["main.js", "manifest.json", "styles.css"];
const inputs = ["src", "lib", "templates", "package.json", "tsconfig.json", "esbuild.config.mjs", "manifest.json", "styles.css"];
const env = { ...process.env };
delete env.TOPMIND_SRC;
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function build(dir) {
  const result = spawnSync(process.execPath, ["esbuild.config.mjs"], { cwd: dir, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return Object.fromEntries(assets.map((asset) => [asset, hash(path.join(dir, "dist", asset))]));
}

const sandbox = mkdtempSync(path.join(tmpdir(), "topmind-repro-"));
try {
  const expected = build(root);
  for (let run = 0; run < 2; run++) {
    const checkout = path.join(sandbox, `checkout-${run}`);
    for (const input of inputs) cpSync(path.join(root, input), path.join(checkout, input), { recursive: true });
    symlinkSync(realpathSync(path.join(root, "node_modules")), path.join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const actual = build(checkout);
    for (const asset of assets) {
      if (actual[asset] !== expected[asset]) throw new Error(`Non-reproducible ${asset}: ${expected[asset]} != ${actual[asset]} (checkout ${run})`);
    }
  }
  for (const asset of assets) console.log(`[repro-build] ${asset} ${expected[asset]}`);
  console.log("[repro-build] 3 builds in different directories are byte-identical");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
