import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInsideVault } from "../bridge/vault-bridge.ts";
import { resolvesOutsideVaultSync } from "#kernel/vault-walk.mjs";
import { prepareArticle, type ArticleDelivery, type WritingPlatform, type WritingTheme } from "../generated/writing/article-renderer.mjs";
import { saveFile, type AgentToolContext } from "./workspace-agent-tools.ts";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function sourceInside(root: string, relative: string): string {
  const absolute = resolveInsideVault(root, relative);
  if (resolvesOutsideVaultSync(root, absolute)) throw new Error("path-outside-workspace");
  return absolute;
}
export async function prepareWritingDelivery(root: string, source: string, platform: WritingPlatform, theme: WritingTheme) {
  if (!/\.md$/iu.test(source)) throw new Error("markdown-source-required");
  const raw = fs.readFileSync(sourceInside(root, source), "utf8");
  const delivery = await prepareArticle({ sourcePath: source, markdown: raw, platform, theme }, async relative => {
    const absolute = sourceInside(root, relative);
    if (fs.statSync(absolute).size > 20 * 1024 * 1024) throw new Error("image-too-large");
    const ext = path.extname(absolute).slice(1).toLowerCase();
    if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) throw new Error("unsupported-image");
    return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${fs.readFileSync(absolute).toString("base64")}`;
  });
  return { delivery, sourceHash: hash(raw) };
}
export function exportWritingDelivery(ctx: AgentToolContext, source: string, sourceHash: string, delivery: ArticleDelivery) {
  if (hash(fs.readFileSync(sourceInside(ctx.workspaceRoot, source), "utf8")) !== sourceHash) throw new Error("source-changed-regenerate");
  const directory = path.posix.dirname(source);
  const name = path.posix.basename(source, path.posix.extname(source));
  const relativePath = `${directory === "." ? "" : `${directory}/`}out/${name}-${delivery.platform}.${delivery.platform === "text" ? "txt" : "html"}`;
  const result = saveFile({ ...ctx, actor: "user" }, { relativePath, content: delivery.platform === "text" ? delivery.text : delivery.html });
  if (!result.ok) throw new Error(String(result.error || "export-failed"));
  if (delivery.images.length) {
    const checklist = saveFile({ ...ctx, actor: "user" }, { relativePath: relativePath.replace(/\.[^.]+$/u, "-images.md"), content: delivery.checklist });
    if (!checklist.ok) throw new Error(`HTML saved: ${relativePath}; image checklist failed`);
  }
  return { ...result, relativePath };
}
