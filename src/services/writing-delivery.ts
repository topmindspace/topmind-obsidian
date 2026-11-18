import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInsideVault } from "../bridge/vault-bridge.ts";
import { resolvesOutsideVaultSync } from "#kernel/vault-walk.mjs";
import { prepareArticle, type ArticleDelivery, type WritingPlatform, type WritingTheme } from "../generated/writing/article-renderer.mjs";
import { saveFile, type AgentToolContext } from "./workspace-agent-tools.ts";
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function sourceInside(root: string, relative: string): string {
  const absolute = resolveInsideVault(root, relative);
  if (resolvesOutsideVaultSync(root, absolute)) throw new Error("path-outside-workspace");
  return absolute;
}
function readLocalImage(root: string, relative: string) {
  const absolute = sourceInside(root, relative);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error("unsupported-image");
  if (stat.size > 20 * 1024 * 1024) throw new Error("image-too-large");
  const ext = path.extname(absolute).slice(1).toLowerCase();
  if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) throw new Error("unsupported-image");
  return { bytes: fs.readFileSync(absolute), mime: ext === "jpg" ? "jpeg" : ext };
}

export async function prepareWritingDelivery(root: string, source: string, platform: WritingPlatform, theme: WritingTheme) {
  if (!/\.md$/iu.test(source)) throw new Error("markdown-source-required");
  const raw = fs.readFileSync(sourceInside(root, source), "utf8");
  const imageHashes = new Map<string, string | null>();
  const delivery = await prepareArticle({ sourcePath: source, markdown: raw, platform, theme }, async relative => {
    try {
      const { bytes, mime } = readLocalImage(root, relative);
      imageHashes.set(relative, hash(bytes));
      return `data:image/${mime};base64,${bytes.toString("base64")}`;
    } catch (error) {
      imageHashes.set(relative, null);
      throw error;
    }
  });
  return { delivery, sourceHash: hash(raw), imageHashes };
}

export function isWritingDeliveryCurrent(root: string, source: string, preview: Awaited<ReturnType<typeof prepareWritingDelivery>>) {
  try {
    if (hash(fs.readFileSync(sourceInside(root, source), "utf8")) !== preview.sourceHash) return false;
  } catch {
    return false;
  }
  for (const [relative, expected] of preview.imageHashes) {
    let current: string | null = null;
    try { current = hash(readLocalImage(root, relative).bytes); } catch { /* Unavailable to the renderer. */ }
    if (current !== expected) return false;
  }
  return true;
}
export function exportWritingDelivery(ctx: AgentToolContext, source: string, sourceHash: string, delivery: ArticleDelivery) {
  if (hash(fs.readFileSync(sourceInside(ctx.workspaceRoot, source), "utf8")) !== sourceHash) throw new Error("source-changed-regenerate");
  const directory = path.posix.dirname(source);
  const name = path.posix.basename(source, path.posix.extname(source));
  const relativePath = `${directory === "." ? "" : `${directory}/`}out/${name}-${delivery.platform}.${delivery.platform === "text" ? "txt" : "html"}`;
  const result = saveFile({ ...ctx, actor: "user" }, { relativePath, content: delivery.platform === "text" ? delivery.text : delivery.html });
  if (!result.ok) throw new Error(String(result.error || "export-failed"));
  const checklistPath = relativePath.replace(/\.[^.]+$/u, "-images.md");
  const checklist = delivery.images.length
    ? saveFile({ ...ctx, actor: "user" }, { relativePath: checklistPath, content: delivery.checklist })
    : null;
  return { ...result, relativePath, checklist: checklist ? { relativePath: checklistPath, ok: checklist.ok } : null };
}
