import test from "node:test";
import assert from "node:assert/strict";
import { buildChatContext } from "../src/services/chat-context.ts";

function loaders(calls) {
  return Object.fromEntries(["stream", "todos", "profile", "reflections"].map((key) => [key, () => {
    calls.push(key);
    return `${key} data`;
  }]));
}

test("greetings do not read any workspace context", async () => {
  const calls = [];
  assert.deepEqual(await buildChatContext("你好", loaders(calls)), []);
  assert.deepEqual(calls, []);
});

test("todo lookup reads only its relevant source", async () => {
  const calls = [];
  const blocks = await buildChatContext("What are my todos?", loaders(calls));
  assert.deepEqual(calls, ["todos"]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /todos data/);
});

test("weekly review includes relevant activity and tolerates a missing source", async () => {
  const calls = [];
  const sources = loaders(calls);
  sources.stream = () => { calls.push("stream"); throw new Error("unavailable"); };
  const blocks = await buildChatContext("整理本周，规划下周", sources);
  assert.deepEqual(calls, ["stream", "todos", "profile", "reflections"]);
  assert.equal(blocks.length, 3);
});

test("ordinary writing keeps preferences without unrelated stream or todo reads", async () => {
  const calls = [];
  const blocks = await buildChatContext("Write a draft", loaders(calls));
  assert.deepEqual(calls, ["profile"]);
  assert.equal(blocks.length, 1);
});

test("prefetched content is bounded and truncation is explicit", async () => {
  const sources = Object.fromEntries(["stream", "todos", "profile", "reflections"].map((key) => [key, () => "x".repeat(10000)]));
  const blocks = await buildChatContext("整理本周", sources);
  assert.ok(blocks.join("\n").length < 8500);
  assert.ok(blocks.every((block) => block.includes("truncated")));
});
