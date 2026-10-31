import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

test("plugin version sources and changelog name the shipped release", () => {
  const pkg = readJson("package.json");
  const manifest = readJson("manifest.json");
  const versions = readJson("versions.json");
  const lock = readJson("package-lock.json");
  assert.equal(manifest.version, pkg.version);
  assert.equal(versions[pkg.version], manifest.minAppVersion);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${pkg.version} — `, "mu"));
  const skills = readJson("src/data/skill-pack.json").version;
  const writing = readJson("src/data/writing-pack.json").version;
  assert.match(changelog, new RegExp(`核心技能快照升至 ${skills}`, "u"));
  assert.match(changelog, new RegExp(`写作快照升至 ${writing}`, "u"));
});
