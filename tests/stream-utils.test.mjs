// ── stream-utils.test.mjs (split from plugin.test.mjs) ──────────────────────────

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fs,
  path,
  pathToFileURL,
  __dirname,
  srcDir,
  pluginRoot,
  importShipped,
} from "./helpers.mjs";


// ── Stream entry parsing (shipped) ─────────────────────────────────────────

describe("assembleMemoryFeed (shipped)", () => {
  test("profile + periodic + topic are separate rows; empty plane is empty", async () => {
    const { assembleMemoryFeed } = await importShipped("utils.ts");
    assert.deepEqual(assembleMemoryFeed(null), []);
    const items = assembleMemoryFeed({
      profile: {
        path: "memory/profile.md",
        markdown: "# 我的情况\n\n## 偏好\n\n- 喜欢简洁\n",
      },
      periodic: [
        {
          path: "memory/periodic/2026-W32.md",
          markdown: "---\ntitle: W32\n---\n\n本周反思一段。\n",
        },
      ],
      topics: [
        { path: "memory/topics/ui.md", markdown: "# UI\n\n单列卡片。\n" },
      ],
    });
    assert.ok(items.some((i) => i.kind === "profile" && i.path === "memory/profile.md"));
    assert.ok(items.some((i) => i.kind === "periodic" && i.path === "memory/periodic/2026-W32.md"));
    assert.ok(items.some((i) => i.kind === "topic" && i.path === "memory/topics/ui.md"));
  });

  test("filterMemoryFeedByLayer keeps one kind (shipped grouping, not a reimplementation)", async () => {
    const { assembleMemoryFeed, filterMemoryFeedByLayer } = await importShipped("utils.ts");
    const items = assembleMemoryFeed({
      profile: {
        path: "memory/profile.md",
        markdown: "# 我的情况\n\n## 偏好\n\n- 喜欢简洁\n",
      },
      periodic: [
        {
          path: "memory/periodic/2026-W32.md",
          markdown: "---\ntitle: W32\n---\n\n本周反思一段。\n",
        },
      ],
      topics: [
        { path: "memory/topics/ui.md", markdown: "# UI\n\n单列卡片。\n" },
      ],
    });
    assert.ok(items.length >= 3);
    const profile = filterMemoryFeedByLayer(items, "profile");
    assert.ok(profile.length >= 1);
    assert.ok(profile.every((i) => i.kind === "profile"));
    assert.ok(profile.every((i) => i.path === "memory/profile.md"));
    const periodic = filterMemoryFeedByLayer(items, "periodic");
    assert.equal(periodic.length, 1);
    assert.equal(periodic[0].kind, "periodic");
    assert.equal(periodic[0].path, "memory/periodic/2026-W32.md");
    const topic = filterMemoryFeedByLayer(items, "topic");
    assert.equal(topic.length, 1);
    assert.equal(topic[0].kind, "topic");
    assert.equal(topic[0].path, "memory/topics/ui.md");
    const all = filterMemoryFeedByLayer(items, "all");
    assert.equal(all.length, items.length);
    assert.deepEqual(filterMemoryFeedByLayer(null, "profile"), []);
  });
});

describe("parseStreamEntries (shipped)", () => {
  test("parses simple time-prefixed entries and tags", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    const content = "# 2026-W01\n\n- 09:30 开始写文档\n- 14:00 开会讨论方案 #urgent #项目A\n";
    const entries = parseStreamEntries(content);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].time, "09:30");
    assert.equal(entries[0].text, "开始写文档");
    assert.equal(entries[1].time, "14:00");
    assert.deepEqual(entries[1].tags, ["urgent", "项目A"]);
  });

  test("prose-first body stays one card and still extracts tags", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    const content = "# Title\n\nSome paragraph\n\n- 11:00 读完书 #阅读 #思考\n";
    const entries = parseStreamEntries(content);
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /Some paragraph/);
    assert.match(entries[0].text, /读完书/);
    assert.ok(entries[0].tags.includes("阅读"));
    assert.ok(entries[0].tags.includes("思考"));
  });

  test("wrapped prose with no list markers is one card, not one card per newline", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    const content = [
      "## 08-03 周一",
      "",
      "This is a long paragraph that wraps",
      "across several lines because the author",
      "hit enter without using list markers.",
    ].join("\n");
    const entries = parseStreamEntries(content);
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /long paragraph/);
    assert.match(entries[0].text, /list markers/);
    assert.equal(entries[0].text.split("\n").filter((l) => l.trim()).length, 3);
  });

  test("list-led day splits timed items; extra paragraphs stay on the same card", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    const timed = parseStreamEntries("## 08-03\n\n- 10:00 a\n- 11:00 b\n");
    assert.equal(timed.length, 2);
    assert.equal(timed[0].time, "10:00");
    assert.equal(timed[1].time, "11:00");

    const continued = parseStreamEntries("## 08-03\n\n- 10:00 lead\n\nsecond paragraph\n");
    assert.equal(continued.length, 1);
    assert.match(continued[0].text, /lead/);
    assert.match(continued[0].text, /second paragraph/);

    const nested = parseStreamEntries("## 08-03\n\n- 10:00 parent\n  - child a\n  - child b\n- 11:00 sibling\n");
    assert.equal(nested.length, 2, `expected 2 first-level cards, got ${nested.length}`);
    assert.match(nested[0].text, /parent/);
    assert.match(nested[0].text, /child a/);
    assert.match(nested[1].text, /sibling/);
  });

  test("returns empty array for empty content", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    assert.equal(parseStreamEntries("").length, 0);
  });

  test("keeps Kernel 增补 after a blank line and strips the machine comment for display", async () => {
    const { parseStreamEntries, prepareStreamEntryTextForDisplay } = await importShipped("utils.ts");
    const content = [
      "- 10:00 原条正文",
      "",
      '<!-- topmind:append parent="10-动态/x" heading="原条正文" at="2026-08-13T00:00:00.000Z" -->',
      "#### 续 · 2026-08-13 12:00",
      "",
      "后续补充一句",
    ].join("\n");
    const entries = parseStreamEntries(content);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].time, "10:00");
    assert.match(entries[0].text, /原条正文/);
    assert.match(entries[0].text, /后续补充一句/);
    assert.match(entries[0].text, /topmind:append/);
    const display = prepareStreamEntryTextForDisplay(entries[0].text);
    assert.doesNotMatch(display, /topmind:append/);
    assert.match(display, /原条正文/);
    assert.match(display, /续 · 2026-08-13/);
    assert.match(display, /后续补充一句/);
  });

  test("formatAppendBlock list and task bodies stay on the same card", async () => {
    const { parseStreamEntries, prepareStreamEntryTextForDisplay } = await importShipped("utils.ts");
    const { formatAppendBlock } = await import(
      pathToFileURL(path.join(__dirname, "..", "lib", "activity-window.mjs")).href
    );
    const when = new Date("2026-08-13T12:00:00.000Z");
    const body =
      "- 10:00 原条正文" +
      formatAppendBlock({
        content: "- 补充一条列表",
        heading: "原条正文",
        date: when,
      }) +
      formatAppendBlock({
        content: "- [ ] 补充待办",
        heading: "原条正文",
        date: new Date("2026-08-13T12:01:00.000Z"),
      });
    const entries = parseStreamEntries(body);
    assert.equal(entries.length, 1, "list/task 增补 must not start a new timed card or be dropped");
    assert.equal(entries[0].time, "10:00");
    assert.match(entries[0].text, /原条正文/);
    assert.match(entries[0].text, /补充一条列表/);
    assert.match(entries[0].text, /补充待办/);
    const display = prepareStreamEntryTextForDisplay(entries[0].text);
    assert.doesNotMatch(display, /topmind:append/);
    assert.match(display, /补充一条列表/);
    assert.match(display, /补充待办/);
  });

  test("later first-level bullet after #### 续 is a new card, not swallowed", async () => {
    const { parseStreamEntries } = await importShipped("utils.ts");
    const content = [
      "## 08-03",
      "",
      "- 10:00 first",
      "#### 续 · 2026-08-03 12:00",
      "comment",
      "- 12:00 third",
    ].join("\n");
    const entries = parseStreamEntries(content);
    assert.equal(entries.length, 2, `expected 2 cards, got ${entries.length}`);
    assert.equal(entries[0].time, "10:00");
    assert.match(entries[0].text, /comment/);
    assert.doesNotMatch(entries[0].text, /third/);
    assert.equal(entries[1].time, "12:00");
    assert.match(entries[1].text, /third/);
  });
});

describe("Desktop-parity feed order + IME Enter guard", () => {
  test("orderStreamEntriesForFeed: newest day first, later clock first, batch stays put", async () => {
    const { orderStreamEntriesForFeed } = await importShipped("utils.ts");
    const entries = [
      { time: "09:00", heading: "2026-07-25", id: "a" },
      { time: "12:00", heading: "2026-07-25", id: "batch1" },
      { time: "12:00", heading: "2026-07-25", id: "batch2" },
      { time: "18:30", heading: "2026-07-25", id: "e" },
      { time: "10:00", heading: "2026-07-24", id: "old1" },
      { time: "11:00", heading: "2026-07-24", id: "old2" },
    ];
    const groups = orderStreamEntriesForFeed(entries, "desc");
    assert.equal(groups.length, 2);
    assert.equal(groups[0].key, "2026-07-25");
    assert.deepEqual(
      groups[0].entries.map((e) => e.id),
      ["e", "batch1", "batch2", "a"],
    );
    assert.equal(groups[1].key, "2026-07-24");
    assert.deepEqual(
      groups[1].entries.map((e) => e.id),
      ["old2", "old1"],
    );

    const asc = orderStreamEntriesForFeed(entries, "asc");
    assert.equal(asc[0].key, "2026-07-24");
    assert.deepEqual(
      asc[0].entries.map((e) => e.id),
      ["old1", "old2"],
    );
  });

  test("isImeEnter blocks composing Enter and post-composition confirm", async () => {
    const { isImeEnter, bindImeEnterGuard } = await importShipped("utils.ts");
    assert.equal(isImeEnter({ isComposing: true, key: "Enter" }), true);
    assert.equal(isImeEnter({ isComposing: false, key: "Process" }), true);
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }), false);

    const guard = { until: Date.now() + 50 };
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }, guard), true);
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }, { until: 0 }), false);

    const handlers = {};
    const el = {
      addEventListener(type, fn) {
        handlers[type] = fn;
      },
    };
    const g = bindImeEnterGuard(el);
    handlers.compositionstart();
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }, g), true);
    handlers.compositionend();
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }, g), true);
    g.until = 0;
    assert.equal(isImeEnter({ isComposing: false, key: "Enter" }, g), false);
  });

  test("workbench + chat + capture all bind the IME guard", () => {
    for (const rel of [
      "views/stream-workbench-view.ts",
      "views/sidebar-dock-view.ts",
      "views/quick-capture-modal.ts",
    ]) {
      const src = fs.readFileSync(path.join(srcDir, rel), "utf8");
      assert.match(src, /bindImeEnterGuard|isImeEnter/, rel);
    }
  });
});

describe("stream workbench display path (shipped)", () => {
  test("workbench has list/card switch and memory browse entry", () => {
    const workbench = fs.readFileSync(
      path.join(srcDir, "views", "stream-workbench-view.ts"),
      "utf-8",
    );
    const main = fs.readFileSync(path.join(srcDir, "main.ts"), "utf-8");
    const memView = fs.readFileSync(
      path.join(srcDir, "views", "memory-browse-view.ts"),
      "utf-8",
    );
    assert.match(workbench, /data-feed-layout-toggle/);
    assert.match(workbench, /data-layout-option/);
    assert.match(workbench, /data-stream-feed/);
    assert.match(workbench, /data-stream-column/);
    assert.match(workbench, /data-stream-open-memory/);
    assert.match(workbench, /openMemoryBrowse/);
    assert.match(main, /VIEW_TYPE_MEMORY_BROWSE/);
    assert.match(main, /openMemoryBrowse/);
    assert.match(main, /CMD_MEMORY_ORGANIZE/);
    const utils = fs.readFileSync(path.join(srcDir, "utils.ts"), "utf-8");
    assert.match(utils, /from ["']#kernel\/memory-feed\.mjs["']/);
    assert.doesNotMatch(utils, /export function assembleMemoryFeed/);
    assert.match(memView, /assembleMemoryFeed/);
    assert.match(memView, /data-memory-feed/);
    assert.match(memView, /data-memory-organize/);
    assert.match(memView, /enqueueAiOperation/);
    assert.match(memView, /memory_organize/);
    assert.match(memView, /filterMemoryFeedByLayer/);
    assert.match(memView, /filterMemoryFeedByLayer\(items,\s*this\.layer\)/);
    assert.match(memView, /chip\.addEventListener\(\s*"click"/);
    assert.match(memView, /aria-pressed/);
    assert.match(memView, /this\.layer\s*=\s*id/);
    assert.match(memView, /for \(const item of visible\)/);
    assert.doesNotMatch(memView, /for \(const item of items\)/);
    assert.match(workbench, /tm-card-dot/);
    assert.match(workbench, /entry\.time/);
    assert.match(workbench, /renderTaskPanel/);
    assert.match(workbench, /task_recent/);
    const design = fs.readFileSync(path.join(__dirname, "..", "DESIGN.md"), "utf-8");
    assert.match(design, /卡片式|单列/);
    assert.match(design, /我的情况/);
  });

  test("cards render prepared display text, not raw append comments", () => {
    const src = fs.readFileSync(
      path.join(srcDir, "views", "stream-workbench-view.ts"),
      "utf-8",
    );
    assert.match(src, /prepareStreamEntryTextForDisplay/);
    assert.match(src, /MarkdownRenderer\.render\(this\.app, displayText/);
    assert.doesNotMatch(src, /MarkdownRenderer\.render\(this\.app, entry\.text/);
    assert.match(src, /displayText\.length > 600/);
    assert.match(src, /navigator\.clipboard\.writeText\(copyText\)/);
    assert.match(src, /length > 20/);
    assert.doesNotMatch(src, /STREAM_EXPAND_CHAR_BUDGET=480/);
  });

  test("stream preview lives in workbench only; createNewNote goes through Kernel", () => {
    const sidebar = fs.readFileSync(
      path.join(srcDir, "views", "sidebar-dock-view.ts"),
      "utf-8",
    );
    const workbench = fs.readFileSync(
      path.join(srcDir, "views", "stream-workbench-view.ts"),
      "utf-8",
    );
    // Dynamic stream is the main-area Stream View — Dock no longer hosts a stream tab.
    assert.doesNotMatch(sidebar, /renderStreamTab/);
    assert.doesNotMatch(sidebar, /sidebar_tab_stream/);
    assert.doesNotMatch(sidebar, /prepareStreamEntryTextForDisplay\(entry\.text\)/);
    assert.match(workbench, /prepareStreamEntryTextForDisplay/);
    assert.match(sidebar, /renderPendingWrites/);
    assert.match(sidebar, /pending_writes_accept/);
    assert.match(workbench, /createInboxNote/);
    assert.doesNotMatch(workbench, /adapter\.write\(filePath/);
  });

  test("DESIGN/ARCHITECTURE fold copy matches shipped 600/20 not 2-line default", () => {
    const design = fs.readFileSync(path.join(__dirname, "..", "DESIGN.md"), "utf-8");
    const arch = fs.readFileSync(path.join(__dirname, "..", "ARCHITECTURE.md"), "utf-8");
    assert.match(design, /600/);
    assert.match(design, /20/);
    assert.doesNotMatch(design, /折叠行数\s*\|\s*2 行/);
    assert.match(arch, /600/);
    assert.match(arch, /20/);
    assert.doesNotMatch(arch, /卡片默认折叠 2 行/);
  });
});

// ── Tag extraction (shipped) ───────────────────────────────────────────────

describe("extractTags (shipped)", () => {
  test("extracts multi-language and hyphenated tags", async () => {
    const { extractTags } = await importShipped("utils.ts");
    assert.deepEqual(extractTags("hello #world"), ["world"]);
    assert.deepEqual(extractTags("#a #b #c"), ["a", "b", "c"]);
    assert.deepEqual(extractTags("完成了 #项目A 的评审"), ["项目A"]);
    assert.deepEqual(extractTags("no tags here"), []);
    assert.deepEqual(extractTags("check #todo-item"), ["todo-item"]);
  });
});

// ── File name sanitization (shipped) ───────────────────────────────────────

describe("sanitizeFileName (shipped)", () => {
  test("removes invalid characters and falls back to untitled", async () => {
    const { sanitizeFileName } = await importShipped("utils.ts");
    assert.equal(sanitizeFileName("test<file>"), "test-file");
    assert.equal(sanitizeFileName('test:file"name'), "test-file-name");
    assert.equal(sanitizeFileName("test|file?name*"), "test-file-name");
    assert.equal(sanitizeFileName(""), "untitled");
    assert.equal(sanitizeFileName("   "), "untitled");
    assert.equal(sanitizeFileName("正常文件名.txt"), "正常文件名.txt");
    assert.equal(sanitizeFileName("<test>"), "test");
  });
});

// ── Period note frontmatter helpers (shipped) ──────────────────────────────

describe("frontmatter helpers (shipped)", () => {
  test("seedPeriodFrontmatter", async () => {
    const { seedPeriodFrontmatter } = await importShipped("utils.ts");
    const result = seedPeriodFrontmatter("10-动态/2026-W01.md");
    assert.ok(result.includes("period: 2026-W01"));
    assert.ok(seedPeriodFrontmatter("2026-W02.md").includes("period: 2026-W02"));
  });

  test("stripFrontmatter / extractFrontmatter", async () => {
    const { stripFrontmatter, extractFrontmatter } = await importShipped("utils.ts");
    const raw = "---\nperiod: 2026-W01\n---\n\n# 2026-W01\n\n- 09:00 hello\n";
    const body = stripFrontmatter(raw);
    assert.ok(!body.startsWith("---"));
    assert.ok(body.includes("# 2026-W01"));
    assert.equal(stripFrontmatter("# No frontmatter\n\nText"), "# No frontmatter\n\nText");
    const fm = extractFrontmatter(raw);
    assert.ok(fm?.startsWith("---"));
    assert.ok(fm?.includes("period: 2026-W01"));
    assert.equal(extractFrontmatter("# No fm\n\nText"), null);
  });
});

// ── Todo mapping (shipped — Kernel `done` field) ───────────────────────────

describe("mapKernelTodoItem (shipped)", () => {
  test("maps Kernel done=true to done:true (not completed)", async () => {
    const { mapKernelTodoItem } = await importShipped("utils.ts");
    const mapped = mapKernelTodoItem({
      id: "abc",
      text: "ship plugin",
      done: true,
      dueDate: "2026-08-10",
      source: "ai",
    });
    assert.equal(mapped.id, "abc");
    assert.equal(mapped.text, "ship plugin");
    assert.equal(mapped.done, true);
    assert.equal(mapped.dueDate, "2026-08-10");
    // Must NOT invent completion from a non-existent `completed` field
    assert.equal("completed" in mapped, false);
  });

  test("maps Kernel done=false and ignores phantom completed field", async () => {
    const { mapKernelTodoItem } = await importShipped("utils.ts");
    const mapped = mapKernelTodoItem({
      id: "x",
      text: "active",
      done: false,
      completed: true, // must be ignored — Kernel does not use this field
    });
    assert.equal(mapped.done, false);
  });
});

// ── Suggestion normalize / map / kind meta (shipped) ───────────────────────

describe("suggestion helpers (shipped)", () => {
  test("normalizeSuggestionList handles array and legacy wrapper", async () => {
    const { normalizeSuggestionList, mapKernelSuggestion } = await importShipped("utils.ts");
    const direct = normalizeSuggestionList([
      { id: "a", kind: "promote_memory", title: "A", summary: "sa", impact: "high" },
    ]);
    assert.equal(direct.length, 1);
    assert.equal(mapKernelSuggestion(direct[0]).id, "a");

    const legacy = normalizeSuggestionList({
      suggestions: [{ id: "x", kind: "create_topic", title: "X", summary: "sx", impact: "medium" }],
    });
    assert.equal(legacy.length, 1);
    assert.equal(mapKernelSuggestion(legacy[0]).kind, "create_topic");

    assert.equal(normalizeSuggestionList(null).length, 0);
    assert.equal(normalizeSuggestionList({}).length, 0);
  });

  test("mergeSoftSuggestionSession keeps previous ids Kernel skipped", async () => {
    const { mergeSoftSuggestionSession } = await importShipped("utils.ts");
    const prev = [
      { id: "ai-1", kind: "promote_memory", title: "A", summary: "keep", impact: "high" },
      { id: "rule", kind: "open_profile", title: "P", summary: "old", impact: "low" },
    ];
    const next = [
      { id: "rule", kind: "open_profile", title: "P", summary: "new", impact: "low" },
    ];
    const dropped = new Set(["gone"]);
    const merged = mergeSoftSuggestionSession(prev, next, dropped);
    assert.equal(merged[0].id, "rule");
    assert.equal(merged[0].summary, "new");
    assert.equal(merged[1].id, "ai-1");
    assert.equal(merged.some((s) => s.id === "gone"), false);
    const forced = mergeSoftSuggestionSession([], next, dropped);
    assert.deepEqual(forced.map((s) => s.id), ["rule"]);
  });

  test("every SuggestionKind has kindMeta icon and border", async () => {
    const { SUGGESTION_KIND_META, ALL_SUGGESTION_KINDS } = await importShipped("utils.ts");
    for (const kind of ALL_SUGGESTION_KINDS) {
      assert.ok(kind in SUGGESTION_KIND_META, `kindMeta missing: ${kind}`);
      const meta = SUGGESTION_KIND_META[kind];
      assert.ok(typeof meta.icon === "string" && meta.icon.length > 0, `${kind} icon`);
      assert.ok(typeof meta.border === "string" && meta.border.length > 0, `${kind} border`);
    }
  });

  test("apply/open labels mirror Desktop: write kinds confirm-to-write, open_profile reads 打开", async () => {
    const { suggestionApplyIsWrite } = await importShipped("utils.ts");
    // All write kinds confirm; open_profile's apply opens the profile.
    // inbox_review is a compatibility kind (product emits inbox_organize) —
    // apply must stay write:true so persisted session cards can still confirm.
    for (const kind of [
      "stream_digest", "ai_summary", "promote_memory", "inbox_review",
      "stale_topic", "catch_all", "inbox_organize", "create_topic",
    ]) {
      assert.equal(suggestionApplyIsWrite(kind), true, kind);
    }
    assert.equal(suggestionApplyIsWrite("open_profile"), false);
    assert.equal(suggestionApplyIsWrite(undefined), false);
  });

  test("suggestionOpenPath resolves targetPath → payload, rejects traversal and placeholders", async () => {
    const { suggestionOpenPath } = await importShipped("utils.ts");
    assert.equal(suggestionOpenPath({ targetPath: "memory/profile.md" }), "memory/profile.md");
    assert.equal(
      suggestionOpenPath({ payload: { sourcePath: "10-动态\\2026\\2026-W30.md" } }),
      "10-动态/2026/2026-W30.md",
      "windows separators normalized",
    );
    assert.equal(suggestionOpenPath({ payload: { path: "../escape.md" } }), null);
    assert.equal(suggestionOpenPath({ targetPath: "10-动态/undefined.md" }), null);
    assert.equal(suggestionOpenPath({ targetPath: "10-动态/period.md" }), null);
    assert.equal(suggestionOpenPath({}), null);
  });

  test("friendlySuggestionPath shortens deep paths with … prefix", async () => {
    const { friendlySuggestionPath } = await importShipped("utils.ts");
    assert.equal(friendlySuggestionPath("10-动态/2026/2026-W30.md"), "… / 2026 / 2026-W30.md");
    assert.equal(friendlySuggestionPath("memory/profile.md"), "memory / profile.md");
    assert.equal(friendlySuggestionPath("profile.md"), "profile.md");
    assert.equal(friendlySuggestionPath(undefined), null);
  });

  test("suggestion action vocabulary keys exist and zh mirrors Desktop semantics", () => {
    const zh = fs.readFileSync(path.join(srcDir, "i18n", "locales", "zh-CN.ts"), "utf-8");
    const en = fs.readFileSync(path.join(srcDir, "i18n", "locales", "en-US.ts"), "utf-8");
    assert.match(zh, /suggestions_confirm:\s*"确认执行"/);
    assert.match(zh, /suggestions_open:\s*"打开"/);
    assert.match(en, /suggestions_open:\s*"Open"/);
  });

  test("Dock is the single suggestion confirm surface; stream only opens it", () => {
    const shared = fs.readFileSync(path.join(srcDir, "views", "suggestion-card.ts"), "utf-8");
    assert.match(shared, /suggestions_confirm/);
    assert.match(shared, /suggestions_open/);
    assert.match(shared, /suggestionApplyIsWrite/);
    assert.match(shared, /tm-suggestion-path/);

    const sidebar = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf-8");
    assert.match(sidebar, /renderSuggestionCard\(container, sugg, \{/, "sidebar must delegate");
    assert.doesNotMatch(sidebar, /tm-btn-confirm/, "sidebar must not copy card DOM");
    assert.doesNotMatch(sidebar, /suggestions_confirm/, "sidebar must not copy vocabulary");

    // Stream view: quiet count entry → revealTab("suggestions"); no second card list.
    const workbench = fs.readFileSync(path.join(srcDir, "views", "stream-workbench-view.ts"), "utf-8");
    assert.match(workbench, /tm-suggest-entry/);
    assert.match(workbench, /revealTab\?\.\("suggestions"\)/);
    assert.doesNotMatch(workbench, /renderSuggestionCard\(container, sugg, \{/);
    assert.doesNotMatch(workbench, /tm-btn-confirm/);
  });
});

// ── Capture normalization (shipped) ────────────────────────────────────────

describe("normalizeCaptureText / isLoneUrlCapture (shipped)", () => {
  test("rejects empty and truncates long text", async () => {
    const { normalizeCaptureText, MAX_CAPTURE_LEN, isLoneUrlCapture } = await importShipped("utils.ts");
    assert.equal(normalizeCaptureText("   \n\t  ").ok, false);
    assert.equal(normalizeCaptureText("   \n\t  ").error, "empty-text");

    const long = "a".repeat(20_000);
    const r = normalizeCaptureText(long);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.text.includes("(truncated)"));
    assert.ok(r.text.length < long.length);
    assert.ok(MAX_CAPTURE_LEN === 10_000);

    const normal = normalizeCaptureText("完成需求评审 #urgent");
    assert.equal(normal.ok, true);
    assert.equal(normal.text, "完成需求评审 #urgent");

    assert.equal(isLoneUrlCapture("https://example.com/page"), true);
    assert.equal(isLoneUrlCapture("see https://example.com later"), false);
    assert.equal(isLoneUrlCapture("plain text"), false);
  });
});

// ── Path filter (shipped) ──────────────────────────────────────────────────

describe("isStreamOrTodoPath (shipped)", () => {
  test("matches stream 10-19, todo, periodic; rejects topics/output/system", async () => {
    const { isStreamOrTodoPath } = await importShipped("utils.ts");
    assert.ok(isStreamOrTodoPath("10-动态/2026-W01.md"));
    assert.ok(isStreamOrTodoPath("10-Stream/2026-W01.md"));
    assert.ok(isStreamOrTodoPath("11-健康/2026-W01.md"));
    assert.ok(isStreamOrTodoPath("memory/todo.md"));
    assert.ok(isStreamOrTodoPath("memory/periodic/2026-W01.md"));
    assert.ok(isStreamOrTodoPath("70-记忆/todo.md"));
    assert.ok(isStreamOrTodoPath("70-记忆/periodic/2026-W01.md"));
    assert.ok(!isStreamOrTodoPath("memory/profile.md"));
    assert.ok(!isStreamOrTodoPath(".topmind/index.json"));
    assert.ok(!isStreamOrTodoPath("topmind.yaml"));
    assert.ok(!isStreamOrTodoPath("20-专题/2026-项目A/topic.md"));
    assert.ok(!isStreamOrTodoPath("88-输出/report.md"));
    assert.ok(!isStreamOrTodoPath("99-归档/backup.md"));
  });
});

describe("Obsidian profile/todo open paths honor Kernel (no hardcoded memory/)", () => {
  test("commands and views open contract-resolved paths", () => {
    const main = fs.readFileSync(path.join(srcDir, "main.ts"), "utf8");
    const stream = fs.readFileSync(path.join(srcDir, "views", "stream-workbench-view.ts"), "utf8");
    const dock = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf8");
    const mem = fs.readFileSync(path.join(srcDir, "views", "memory-browse-view.ts"), "utf8");
    assert.doesNotMatch(main, /openLinkText\("memory\/profile\.md"/);
    assert.match(main, /openMemoryBrowse/);
    assert.match(main, /VIEW_TYPE_MEMORY_BROWSE/);
    assert.doesNotMatch(stream, /openLinkText\("memory\/profile\.md"/);
    assert.match(stream, /openMemoryBrowse/);
    assert.match(mem, /profileRelPath\(\)/);
    assert.doesNotMatch(mem, /openLinkText\("memory\/profile\.md"/);
    assert.doesNotMatch(dock, /openLinkText\("memory\/todo\.md"/);
    assert.match(dock, /todoRelPath\(\)/);
  });
});

describe("suggestion cache and todo force (Desktop parity)", () => {
  test("kernel-service peeks session cards and throttles soft generate", () => {
    const svc = fs.readFileSync(path.join(srcDir, "services", "kernel-service.ts"), "utf8");
    assert.match(svc, /peekSuggestions\(\)/);
    assert.match(svc, /lastSuggestKernelAt/);
    assert.match(svc, /< 5000/);
    assert.match(svc, /notice_executing/);
    assert.match(svc, /opts: \{ silent\?: boolean \}/);
  });

  test("boot auto-maintain is quiet and not force; user commands force", () => {
    const main = fs.readFileSync(path.join(srcDir, "main.ts"), "utf8");
    assert.match(main, /force = normalized\.force \?\? !quiet/);
    assert.match(main, /runOperation\(operation, \{ force \}\)/);
    assert.match(main, /enqueueAiOperation\("todo_maintain".*"sidebar", true\)/);
    const dock = fs.readFileSync(path.join(srcDir, "views", "sidebar-dock-view.ts"), "utf8");
    assert.match(dock, /peekSuggestions\(\)/);
    assert.match(dock, /acceptAllSuggestions/);
    assert.match(dock, /softRefreshSuggestions/);
    const stream = fs.readFileSync(path.join(srcDir, "views", "stream-workbench-view.ts"), "utf8");
    assert.match(stream, /peekSuggestions\(\)/);
    // Desktop-parity feed order lives in utils.orderStreamEntriesForFeed —
    // days newest-first, later clock times first, same-minute batch stays put.
    assert.match(stream, /orderStreamEntriesForFeed\(/);
    assert.doesNotMatch(stream, /\[\.\.\.entries\]\.reverse\(\)/);
    assert.doesNotMatch(stream, /\[\.\.\.groups\]\.reverse\(\)/);
  });
});

