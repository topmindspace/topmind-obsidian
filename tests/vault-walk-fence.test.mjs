import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("agent search and list_files stay out of packages and escaping links", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-obs-fence-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tm-obs-fence-out-"));
  try {
    const topic = path.join(tmp, "40-创作", "topic");
    fs.mkdirSync(path.join(topic, "Fake.app", "Contents"), { recursive: true });
    fs.writeFileSync(path.join(topic, "note.md"), "FENCE_TOKEN real note\n", "utf8");
    fs.writeFileSync(path.join(topic, "Fake.app", "Contents", "inside.md"), "FENCE_TOKEN inside app\n", "utf8");
    fs.writeFileSync(path.join(outside, "marker.md"), "FENCE_TOKEN outside\n", "utf8");
    try {
      fs.symlinkSync(outside, path.join(topic, "escape"));
    } catch (err) {
      throw new Error(`symlink required for the vault fence: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tools = await import(pathToFileURL(path.join(pluginSrc, "services/workspace-agent-tools.ts")).href);
    const ctx = {
      kernel: {
        loadContract() { throw new Error("no contract"); },
        resolveWorkspaceModel() { throw new Error("no model"); },
      },
      workspaceRoot: tmp,
    };
    const found = tools.searchWorkspace(ctx, { query: "FENCE_TOKEN" });
    const rels = (found.results || []).map((hit) => hit.relativePath);
    assert.ok(rels.includes("40-创作/topic/note.md"), rels.join(", "));
    assert.equal(rels.some((rel) => rel.includes("Fake.app") || rel.includes("inside.md")), false);
    assert.equal(rels.some((rel) => rel.includes("marker.md") || rel.includes("escape")), false);

    const listed = tools.listFiles(ctx, { relativePath: "40-创作/topic" });
    assert.equal(listed.ok, true);
    assert.ok(listed.files.includes("40-创作/topic/note.md"));
    assert.equal(listed.files.some((name) => name.includes("Fake.app")), false);
    assert.equal(listed.files.some((name) => name.includes("escape")), false);

    const topicFiles = tools.listTopicFiles(ctx, "40-创作/topic");
    assert.equal(topicFiles.ok, true);
    assert.ok(topicFiles.files.some((file) => file.name === "note.md"));
    assert.equal(topicFiles.files.some((file) => file.name === "Fake.app" || file.name === "escape"), false);
    assert.equal(tools.listTopicFiles(ctx, "40-创作/topic/Fake.app").ok, false);

    const through = tools.statPath(ctx, "40-创作/topic/escape/marker.md");
    assert.equal(through.ok, false);

    const scoped = tools.searchWorkspace(ctx, { query: "FENCE_TOKEN", scope: "40-创作/topic/Fake.app" });
    assert.equal((scoped.results || []).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
