# Topmind Stream for Obsidian — English

The English README lives at **[README.md](README.md)** (canonical).

中文文档见 **[README.zh-CN.md](README.zh-CN.md)**。

## Writing and delivery

A reviewed release snapshot of [topmind-writing-skills](https://github.com/topmindspace/topmind-writing-skills) is bundled by default: revision, formatting, briefs, social posts, WeChat, X Articles, covers and posters. The writing repository keeps its own release cadence and version.

Open **Writing & delivery** from the ribbon, workbench toolbar, note/editor menu or command palette (`topmind-stream:writing-delivery`). Choose the source article. Selecting an action shows its purpose, requirements and review/edit mode; **Start AI task** begins execution explicitly. Edit the source in the main editor, choose a delivery format and theme, then preview, copy or export beside it in `out/`. Existing article folders and WeChat drafts work in place.

Built-in HTML/text typography requires no Python. Preview and copy use the same output; changed sources or images require regeneration. Diagnostics identify missing images, diagram source, extended containers and table paste limitations. The current chat host has no image-input, image-generation or PNG-rendering tool. Cover/poster actions prepare prompts or HTML only. Publishing requires its own tool and authorization. Copying does not publish; wording scores do not decide editorial quality.

The plugin updates through its normal release channel. `main.js` contains the core and writing resources, so Desktop is not required. Executable writing code is not downloaded at runtime.
