// Docs must describe the shipped settings, filesystem, clipboard, CSS, and build.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const docs = ["ARCHITECTURE.md"];

test("architecture is the canonical home for implementation and community-review disclosures", () => {
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

// User READMEs explain real paths and recovery without repeating every internal rule.
test("user READMEs explain first use, confirmation, current target and common recovery", () => {
 for (const name of ["README.md","README.zh-CN.md"]) {
  const text=fs.readFileSync(path.join(root,name),"utf8");
  assert.match(text,/首次打开即可配置|before any key is saved/);
  assert.match(text,/当前笔记与选区|Current note and selection/);
  assert.match(text,/哪些操作需要确认|What needs confirmation/);
  assert.match(text,/常见问题|Common questions/);
  assert.match(text,/ARCHITECTURE\.md/);
  assert.doesNotMatch(text,/绝对不会|without conflicts|Vercel AI SDK v7|agent 脊/);
 }
});

test("README and current UX review local links resolve", () => {
 for(const name of ["README.md","README.zh-CN.md","docs/UX-REVIEW-2026-10-25.md"]) {
  const text=fs.readFileSync(path.join(root,name),"utf8");
  for(const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
   const link=match[1].split('#')[0];if(!link||/^[a-z]+:/iu.test(link)) continue;
   assert.ok(fs.existsSync(path.resolve(root,path.dirname(name),decodeURIComponent(link))),`${name}: ${link}`);
  }
 }
});
