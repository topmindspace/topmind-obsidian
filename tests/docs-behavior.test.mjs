// Docs must describe the shipped settings, filesystem, clipboard, CSS, and build.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const docs = ["README.zh-CN.md", "README.md", "ARCHITECTURE.md", "CHANGELOG.md"];

test("README, ARCHITECTURE, and CHANGELOG match first-run AI setup and review fixes", () => {
  for (const name of docs) {
    const text = fs.readFileSync(path.join(root, name), "utf8");
    assert.match(text, /首次打开即可配置|before any key is saved/, name);
    assert.match(text, /服务商|provider/i, name);
    assert.match(text, /模型|model/i, name);
    assert.match(text, /API [Kk]ey|密钥/, name);
    assert.doesNotMatch(text, /只要配置了任意一个/, name);
    assert.doesNotMatch(text, /only after a provider is configured/i, name);
    assert.doesNotMatch(text, /model dropdown appears only after/i, name);
    assert.match(text, /不扫描用户主目录|does not scan your home directory|no home-directory scan/, name);
    assert.doesNotMatch(text, /~\/topmind/, name);
    assert.match(text, /writeText/, name);
    assert.match(text, /点击|click/i, name);
    assert.match(text, /不含 `!important`|no `!important`/, name);
    assert.match(text, /可复现|reproducible/, name);
    assert.match(text, /main\.js/, name);
    assert.match(text, /lockfile|vendored/, name);
  }
});
