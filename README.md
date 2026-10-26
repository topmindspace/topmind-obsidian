# Topmind Stream for Obsidian

English · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

Capture thoughts, continue working on notes, and ask AI to find information, organize todos, or suggest updates. Your content lives in your Vault. Capture and browsing work without AI.

Requires **Obsidian desktop 1.13.0 or later**. Mobile is not supported. The version source is [manifest.json](manifest.json).

## Writing and delivery

A reviewed release snapshot of [topmind-writing-skills](https://github.com/topmindspace/topmind-writing-skills) is bundled by default: revision, formatting, briefs, social posts, WeChat, X Articles, covers and posters. The writing repository keeps its own release cadence and version.

Open a Markdown document and choose **Writing & delivery** from the command palette. Edit the source in the main editor, choose a delivery format and theme, then preview, copy or export beside it in `out/`. Existing article folders and WeChat drafts work in place.

Built-in HTML/text typography requires no Python. Preview and copy use the same output; changed sources or images require regeneration. Diagnostics identify missing images, diagram source, extended containers and table paste limitations. AI images, PNG rendering and publishing require their respective tools. Copying does not publish; wording scores do not decide editorial quality.

The plugin updates through its normal release channel. `main.js` contains the core and writing resources, so Desktop is not required. Executable writing code is not downloaded at runtime.

## Start in three minutes

1. **Install and enable** the plugin using the instructions below.
2. Choose **Topmind: Open Stream** in the command palette. For a new workspace, click **Initialize workspace**; the default stream template is enough to start. Other templates are available in Settings.
3. Type something in Stream and press **Enter**. It is saved in the period note, which you can also open from Obsidian's file explorer.
4. For AI, open **Settings → Topmind Stream → AI provider and model**, configure a provider and model, and test the connection. You can skip this step.

**Stream** is for capture and review. The **AI copilot** holds Chat, Suggestions, Todos, and History. **Note it** opens a quick capture dialog. **My profile** lets you browse profile and other memory notes.

## Install and upgrade

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/topmindspace/topmind-obsidian/releases).
2. Place them in `<Vault>/.obsidian/plugins/topmind-stream/`. If you changed Obsidian's configuration directory, use that directory instead.
3. Reload Obsidian and enable **Topmind Stream** in **Settings → Community plugins**.

A locally built `topmind-obsidian-*.zip` can be extracted into that plugin directory. Make sure `main.js` is directly inside it, without an extra nested folder. GitHub's **Source code ZIP** must be built before installation.

### BRAT or the community directory

BRAT users can add `topmindspace/topmind-obsidian`. If Topmind Stream is searchable in Obsidian's community directory, you can install it there; otherwise use manual installation or BRAT.

### Upgrade

Use the corresponding update action for community/BRAT installs. For a manual install, replace the three plugin files above and reload. Keep `data.json`, which stores settings and credentials. Upgrading does not replace notes, `topmind.yaml`, or `memory/` in your content area.

## Configure AI (optional)

Provider and model controls are available **before any key is saved**.

1. Select a provider under **AI provider and model**.
2. Enter an API key for a hosted provider, a Base URL for Ollama, or both a Base URL and API key for a custom compatible endpoint.
3. Select a model. Use a custom model ID if it is missing from the list; an empty model uses the provider default.
4. Run the connection test in Settings. You can also click the status dot beside the chat input. If it fails, check the endpoint, credentials, and model availability.

Upgrades retain your saved setup. Desktop import reads only the export file you select; the plugin does not scan your home directory. Undecryptable credentials are rejected rather than treated as usable keys.

Notes stay local; AI requests send relevant context to your configured provider. Credentials are stored in the plugin's `data.json`. Optional plaintext credential backup in the Vault is off by default. Check credentials before sharing or syncing plugin configuration.

## Everyday use

| What you want to do | Where to go |
|---|---|
| Capture a thought | **Note it** in the command palette or the pencil icon; choose Stream or Inbox |
| Review the week | **Stream**; switch periods, filter, or expand long entries |
| Ask AI about a note | Open the note → **Chat** → check **Send target** → enter your request |
| Add a todo | Type directly in **Todos**; check it off when done |
| Review AI proposals | **Suggestions**; inspect the target and action, then accept or dismiss |
| Check background work | **History** for queued, running, completed, or failed operations |
| Update your profile | Open **My profile** or ask AI for a reviewable memory update |

Try “Summarize this note,” “Find unfinished work from this week,” or “Append this paragraph to the current note.” Make the intent explicit when you want files changed.

### Current note and selection

**Send target** above the composer names the object for your **next send**. Select text before sending to narrow the scope. Switching tabs after sending does not change that turn's target; each reply identifies its bound object.

With no note selected, Chat can still search the workspace. To edit a specific note, open it or name its path. Save unsaved editor changes before asking AI to edit; the plugin checks for conflicts.

### Input, pause, and resume

- **Enter** sends/submits; **Shift+Enter** inserts a new line. IME candidate confirmation does not send.
- During a chat run, click the square button or press **Esc** in the input to pause. Completed file changes are kept.
- Resume continues the original goal. Abandoning does not undo completed changes.
- Closing the copilot pauses and saves the conversation; reopening restores it. Clearing Chat clears conversation state only.
- Unsent todos survive tab switches and repaints. Background chat progress does not replace a todo you are typing.
- Reading older chat messages keeps your position when progress or a reply arrives. Use **Back to latest** when ready.
- Filter active todos and load more when needed. Expand completed todos and uncheck one to restore it. Clearing completed affects all completed items; filtering applies to active items only.

### What needs confirmation

Proactive organization and memory suggestions can be dismissed. Requested content creation and edits save directly.

**Ask before deleting/archiving** places deletion/archive actions in **Pending actions**. A deletion card explicitly says **Confirm deletion** and names its target. **Auto-save** allows authorized lifecycle actions directly; it does not accept every suggestion automatically. Failed or stale actions stay available for inspection and retry.

## Common questions

**The plugin is missing or will not load.** Check your desktop Obsidian version, community-plugin enablement, and the location of the three plugin files. A source ZIP cannot be enabled directly.

**Do I need an AI key to take notes?** No. Capture, browsing, and manual todos work without it.

**A selected model fails the connection test.** Check that the provider, Base URL, key, and model ID belong to the same service, then test again in Settings. Connectivity does not prove support for every task.

**No suggestions appear.** Check AI configuration and the automatic-suggestions option. Manual refresh may make a model request. Pending review cards remain available regardless of that option.

**The editor is unsaved or the file changed.** Save the editor, reread the relevant note, and retry. Concurrent Desktop/Obsidian edits can still conflict.

**Chat or suggestion state is damaged.** The plugin shows an error and preserves the original file. Back up your Vault, check `.topmind/` permissions or disk-sync issues, fix the problem, then retry. Do not start by deleting the whole state directory.

**Fetch a URL or just record its link?** Fetch downloads the page content into Inbox. Submitting normally records the link. Fetch prevents duplicate submission; closing the dialog prevents a late response from being captured.

## Commands and previews

Search **Topmind** in Obsidian's command palette for Note it, Open Stream, Open sidebar, Reconcile this week, Refresh AI suggestions, AI tidy todos, Classify topics, Organize my profile, Open my profile, and Open Inbox. No default global hotkeys are assigned; bind your own in **Settings → Hotkeys**.

[Stream preview](docs/images/stream-timeline-en.png) · [My profile preview](docs/images/profile-memory-en.png) · [UX review](docs/UX-REVIEW-2026-10-25.md)

## Development and implementation

See [ARCHITECTURE.md](ARCHITECTURE.md) for data, tool, privacy and permission boundaries, and [DESIGN.md](DESIGN.md) for interaction decisions. The [refactor record](docs/OBSIDIAN-REFACTOR-2026-10-25.md) explains the runtime and remaining work. Obsidian keeps its native editor; Desktop has its own editor. Both use Kernel content contracts.

The full verification runs on Node 22.22.3; tests need TypeScript type-stripping support. `npm ci` uses the lockfile. `npm run typecheck` syncs an available Kernel source; production builds use the vendored snapshot.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run pack
npm run pack:verify
```

Plugin: [topmindspace/topmind-obsidian](https://github.com/topmindspace/topmind-obsidian). Kernel: [topmindspace/topmind](https://github.com/topmindspace/topmind). [MIT License](LICENSE).
