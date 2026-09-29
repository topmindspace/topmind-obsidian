// ── Capture fetch: URL → article Markdown (Desktop 记一下 parity) ─────────
//
// Desktop QuickCapture pipeline: detect URL → classify (GitHub md / web) →
// fetch → extract title + body → build compact source header → Inbox article.
// Obsidian path uses host `requestUrl` (never global fetch) and the shared
// kernel github-md helpers so GitHub markdown stays byte-parity with Desktop.
//
// Pure extract/build helpers live here so unit tests can import without the
// Obsidian runtime; only `fetchUrlForCapture` takes a host HTTP function.

import {
  isGithubMarkdownFileUrl,
  preferGithubRawUrl,
  rewriteGithubMarkdownImages,
  parseGithubFileUrl,
  parseGithubRepoReadmeTarget,
  titleFromMarkdown,
} from "#kernel/github-md.mjs";

/** Kernel github-md file ref (JSDoc typedef — mirrored here for TS). */
type GithubFileRef = { owner: string; repo: string; ref: string; path: string };

export type HostFetchPage = (url: string) => Promise<{
  ok: boolean;
  status?: number;
  text?: string;
  error?: string;
}>;

export type FetchCaptureResult = {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  siteName?: string;
  author?: string;
  image?: string | null;
  method: "x-status" | "github-raw" | "heuristic";
  wordCount: number;
  truncated: boolean;
  error?: string;
};

/**
 * Parse an X/Twitter status or article URL (Desktop parseXStatusOrArticle parity).
 * `/i/article/<id>` → articleId · `/:user/status/:id` → screenName + statusId.
 */
export function parseXStatusOrArticle(
  raw: string,
): { screenName?: string; statusId?: string; articleId?: string; canonical: string } | null {
  let u: URL;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "x.com" && host !== "twitter.com" && host !== "mobile.twitter.com") {
    return null;
  }
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts[0] === "i" && parts[1] === "article" && parts[2]) {
    const id = parts[2].replace(/\D/gu, "") || parts[2];
    return { articleId: id, canonical: `https://x.com/i/article/${id}` };
  }
  const statusIdx = parts.indexOf("status");
  if (statusIdx > 0 && parts[statusIdx + 1]) {
    const screenName = parts[statusIdx - 1];
    const statusId = String(parts[statusIdx + 1]).replace(/\D/gu, "");
    if (screenName && statusId) {
      return {
        screenName,
        statusId,
        canonical: `https://x.com/${screenName}/status/${statusId}`,
      };
    }
  }
  return null;
}

/** Strip brand suffixes from og:title / <title> ("Post | Site" → "Post"). */
export function cleanCaptureTitle(raw: string, siteName?: string): string {
  let t = String(raw || "")
    .replace(/\s+/gu, " ")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .trim();
  if (!t) return "";
  const sn = siteName?.trim() || "";
  const sepRe = /\s*[|»›·•]\s*|\s+[-–—]\s+/u;
  if (sepRe.test(t)) {
    const parts = t.split(sepRe).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const left = parts[0];
      const right = parts[parts.length - 1];
      const rightIsSite =
        (sn &&
          (right.toLowerCase().includes(sn.toLowerCase().slice(0, 12)) ||
            sn.toLowerCase().includes(right.toLowerCase().slice(0, 12)))) ||
        (right.length <= 36 && left.length >= 8 && left.length >= right.length);
      if (rightIsSite && left.length >= 4) t = left;
      else if (parts.length === 2 && left.length >= 12 && right.length <= 28) t = left;
    }
  }
  t = t.replace(/^(Home|首页|主页)\s*[>|/›»-]+\s*/iu, "").trim();
  if (t.length > 120) t = `${t.slice(0, 119).trim()}…`;
  return t;
}

function decodeEntities(s: string): string {
  return String(s || "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&hellip;/giu, "…")
    .replace(/&mdash;/giu, "—")
    .replace(/&ndash;/giu, "–")
    .replace(/&#(\d+);/gu, (_, n) => String.fromCharCode(Number(n) || 0));
}

/** og:/meta/title extraction — mirrors Desktop extractMeta shape. */
export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const ogPattern = /<meta\s+(?:property|name)=["']og:([a-z_]+)["']\s+content=["']([^"']*)["']/giu;
  let m: RegExpExecArray | null;
  while ((m = ogPattern.exec(html))) {
    meta[`og_${m[1].replace(/_/gu, "")}`] = decodeEntities(m[2].trim());
  }
  // twitter:* cards fill the gap on sites whose og:title is a brand shell.
  const twPattern = /<meta\s+(?:property|name)=["']twitter:([a-z_]+)["']\s+content=["']([^"']*)["']/giu;
  while ((m = twPattern.exec(html))) {
    const key = `twitter_${m[1].replace(/_/gu, "")}`;
    if (!meta[key]) meta[key] = decodeEntities(m[2].trim());
  }
  const stdPattern = /<meta\s+name=["'](description|author)["']\s+content=["']([^"']*)["']/giu;
  while ((m = stdPattern.exec(html))) {
    meta[m[1]] = decodeEntities(m[2].trim());
  }
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/iu);
  if (titleMatch) meta.title = decodeEntities(titleMatch[1].trim());
  return meta;
}

/** HTML fragment → lightweight Markdown (capture-grade, not browser-grade). */
export function htmlToMarkdown(html: string, maxLen = 200_000): string {
  let s = String(html || "");
  s = s.replace(/<(script|style|svg|noscript|template|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/giu, "");
  s = s.replace(/<!--[\s\S]*?-->/gu, "");
  // Isolate main content when the page has an obvious article region.
  const mainMatch = s.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/iu);
  if (mainMatch && mainMatch[1].trim().length > 200) s = mainMatch[1];
  // Block conversions
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_m: string, lv: string, inner: string) => `\n\n${"#".repeat(Number(lv))} ${stripTags(inner).trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_m: string, inner: string) => `\n- ${stripTags(inner).trim()}`);
  s = s.replace(/<(?:ul|ol)\b[^>]*>/giu, "\n");
  s = s.replace(/<\/(?:ul|ol)>/giu, "\n");
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (_m: string, inner: string) => `\n\n> ${stripTags(inner).trim().replace(/\n+/gu, "\n> ")}\n\n`);
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (_m: string, inner: string) => `\n\n\`\`\`\n${decodeEntities(stripTags(inner)).replace(/\n{3,}/gu, "\n\n").trim()}\n\`\`\`\n\n`);
  s = s.replace(/<br\s*\/?>/giu, "\n");
  s = s.replace(/<\/p>/giu, "\n\n");
  s = s.replace(/<p\b[^>]*>/giu, "");
  // Inline: images / links / emphasis must run before the blanket tag strip.
  s = s.replace(/<img\b[^>]*?(?:src|data-src)=["']([^"']+)["'][^>]*>/giu, (_m: string, src: string) => `![](${src})`);
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_m: string, href: string, inner: string) => {
    const label = stripTags(inner).trim();
    return label ? `[${label}](${href})` : href;
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/giu, (_m: string, _tag: string, inner: string) => `**${stripTags(inner).trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/giu, (_m: string, _tag: string, inner: string) => `*${stripTags(inner).trim()}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, (_m: string, inner: string) => `\`${stripTags(inner).trim()}\``);
  s = stripTags(s);
  s = decodeEntities(s)
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function stripTags(s: string): string {
  return String(s || "").replace(/<[^>]+>/gu, "");
}

function wordCount(text: string): number {
  const t = String(text || "").trim();
  if (!t) return 0;
  // CJK chars count as one word each; latin runs count as one word.
  const cjk = (t.match(/[一-鿿一-鿿぀-ヿ가-힯]/gu) || []).length;
  const latin = (t.replace(/[一-鿿぀-ヿ가-힯]/gu, " ").match(/[A-Za-z0-9]+/gu) || []).length;
  return cjk + latin;
}

/**
 * Compact source header + body — Desktop `buildFetchMarkdown` parity.
 * `> 来源: url` / author / site, then cover image, then extracted body.
 */
export function buildFetchMarkdown(
  result: Pick<FetchCaptureResult, "url" | "text" | "author" | "siteName" | "image">,
  label: { source: string; author: string; site: string; noBody: string },
): string {
  const metaLines = [`> ${label.source}: ${result.url}`];
  if (result.author) metaLines.push(`> ${label.author}: ${result.author}`);
  if (result.siteName) metaLines.push(`> ${label.site}: ${result.siteName}`);
  const header = `${metaLines.join("\n")}\n\n`;
  let body = (result.text || "").trim() || label.noBody;
  const cover = typeof result.image === "string" ? result.image : "";
  if (cover && !body.includes(cover) && !/!\[[^\]]*\]\(/u.test(body.slice(0, 400))) {
    body = `![cover](${cover})\n\n${body}`.trim();
  }
  return `${header}${body}`;
}


/**
 * fxtwitter JSON API → capture result (Desktop fetchXStatus parity).
 * Title rule: X article → article.title; plain status → first line of text
 * (the post's opening claim reads like a headline, e.g. 「正式开源！…来了！」).
 */

type GithubReadmeTarget = {
  owner: string;
  repo: string;
  ref?: string;
  subdir?: string;
};

/**
 * Resolve `owner/repo[/tree/…]` → README markdown via api.github.com/readme,
 * then raw.githubusercontent. Title = README H1 (titleFromMarkdown).
 */
async function fetchGithubReadme(
  fetchPage: HostFetchPage,
  target: GithubReadmeTarget,
  canonical: string,
  maxLen: number,
): Promise<FetchCaptureResult | null> {
  try {
    const sub = (target.subdir || "").replace(/^\/+|\/+$/g, "");
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/readme`;
    const apiPath = sub
      ? `${apiBase}/${sub.split("/").map(encodeURIComponent).join("/")}`
      : apiBase;
    const apiUrl = target.ref ? `${apiPath}?ref=${encodeURIComponent(target.ref)}` : apiPath;
    const metaRes = await fetchPage(apiUrl);
    if (!metaRes.ok || typeof metaRes.text !== "string") return null;
    const meta = JSON.parse(metaRes.text) as { path?: string; download_url?: string | null };
    const readmePath = String(meta.path || "").trim();
    const rawUrl = typeof meta.download_url === "string" ? meta.download_url : "";
    if (!readmePath && !rawUrl) return null;
    const finalRaw =
      rawUrl && /^https:\/\//u.test(rawUrl)
        ? rawUrl
        : `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref || "HEAD"}/${readmePath}`;
    const mdRes = await fetchPage(finalRaw);
    if (!mdRes.ok || typeof mdRes.text !== "string" || !mdRes.text.trim()) return null;
    const md = mdRes.text;
    const text = md.length > maxLen ? `${md.slice(0, maxLen)}…` : md;
    return {
      ok: true,
      url: canonical,
      title: titleFromMarkdown(md, readmePath || "README.md"),
      text,
      siteName: "GitHub",
      method: "github-raw",
      wordCount: wordCount(text),
      truncated: md.length > maxLen,
    };
  } catch {
    return null;
  }
}

async function fetchXStatusViaFx(
  fetchPage: HostFetchPage,
  screenName: string,
  statusId: string,
  canonical: string,
  maxLen: number,
): Promise<FetchCaptureResult | null> {
  const endpoint = `https://api.fxtwitter.com/${encodeURIComponent(screenName)}/status/${encodeURIComponent(statusId)}`;
  try {
    const r = await fetchPage(endpoint);
    if (!r.ok || typeof r.text !== "string") return null;
    const data = JSON.parse(r.text) as {
      tweet?: {
        author?: { name?: string; screen_name?: string };
        text?: string;
        raw_text?: string;
        article?: { title?: string; preview_text?: string };
        media?: {
          photos?: Array<{ url?: string; media_url_https?: string }>;
          videos?: Array<{ thumbnail_url?: string }>;
        };
      };
    };
    const tweet = data?.tweet;
    if (!tweet) return null;

    const author = tweet.author || {};
    const handle = author.screen_name?.replace(/^@/u, "");
    const authorName =
      (author.name || "").trim() || (author.screen_name || "").trim() || undefined;

    const text = String(tweet.text || tweet.raw_text || "").trim();
    const images: string[] = [];
    for (const ph of Array.isArray(tweet.media?.photos) ? tweet.media.photos : []) {
      const u = ph?.url || ph?.media_url_https;
      if (typeof u === "string" && /^https?:\/\//u.test(u) && !images.includes(u)) images.push(u);
    }

    let title: string;
    let body: string;
    if (tweet.article && typeof tweet.article === "object") {
      // X long-form article: title is the article's own headline.
      title = clipText(String(tweet.article.title || "").trim() || "X 文章", 120);
      const preview = String(tweet.article.preview_text || "").trim();
      body = preview || text;
    } else {
      // Plain status: first line IS the headline users see on the card.
      const firstLine = text.split(/\n/u)[0] || "";
      title = clipText(firstLine.replace(/\s+/gu, " "), 120) || `@${handle || "x"} 的动态`;
      body = text;
    }

    const parts: string[] = [];
    if (images[0]) parts.push(`![image](${images[0]})`);
    if (body) parts.push(body);
    for (const img of images.slice(1)) parts.push(`![image](${img})`);
    let full = parts.join("\n\n").trim() || text;
    if (full.length > maxLen) full = `${full.slice(0, maxLen)}…`;

    return {
      ok: true,
      url: canonical,
      title,
      text: full,
      siteName: "X",
      author:
        authorName && handle && authorName !== handle
          ? `${authorName} (@${handle})`
          : authorName || (handle ? `@${handle}` : undefined),
      image: images[0] || null,
      method: "x-status",
      wordCount: wordCount(full),
      truncated: full.endsWith("…"),
    };
  } catch {
    return null;
  }
}

function clipText(s: string, n: number): string {
  const t = String(s || "").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/**
 * Fetch a capture URL into article Markdown.
 * GitHub markdown files go through raw.githubusercontent (clean MD + image
 * rewrite); everything else is HTML → heuristic Markdown.
 */
export async function fetchUrlForCapture(
  fetchPage: HostFetchPage,
  rawUrl: string,
  opts: { maxLen?: number } = {},
): Promise<FetchCaptureResult> {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//iu.test(url)) {
    return { ok: false, url, title: "", text: "", method: "heuristic", wordCount: 0, truncated: false, error: "invalid-url" };
  }
  const maxLen = opts.maxLen ?? 200_000;

  // X/Twitter: HTML scrape on x.com is an SPA shell and yields wrong titles /
  // empty bodies. Route through the fxtwitter JSON API first (Desktop parity).
  const xParsed = parseXStatusOrArticle(url);
  if (xParsed?.statusId && xParsed.screenName) {
    const xResult = await fetchXStatusViaFx(
      fetchPage,
      xParsed.screenName,
      xParsed.statusId,
      xParsed.canonical,
      maxLen,
    );
    if (xResult) return xResult;
    // fall through to HTML on API failure — better a rough note than nothing
  }

  // GitHub repo/tree → resolve the README via the REST API, then raw-fetch it.
  // Keeps repo-page titles as the README H1 (Desktop github-fetch parity).
  const readmeTarget = parseGithubRepoReadmeTarget(url);
  if (readmeTarget && !parseGithubFileUrl(url)) {
    const readmeResult = await fetchGithubReadme(fetchPage, readmeTarget, url, maxLen);
    if (readmeResult) return readmeResult;
    // fall through to HTML page scrape on API failure
  }

  const githubRef: GithubFileRef | null = parseGithubFileUrl(url);
  const target = isGithubMarkdownFileUrl(url) ? preferGithubRawUrl(url) : url;

  try {
    const r = await fetchPage(target);
    if (!r.ok || typeof r.text !== "string") {
      return {
        ok: false,
        url,
        title: "",
        text: "",
        method: "heuristic",
        wordCount: 0,
        truncated: false,
        error: r.error || `http-${r.status ?? 0}`,
      };
    }

    // GitHub markdown → already Markdown; rewrite relative images to raw.
    if (githubRef && isGithubMarkdownFileUrl(url)) {
      const md = rewriteGithubMarkdownImages(r.text, githubRef);
      const titleGuess = (md.match(/^#\s+(.+)$/mu) || [])[1] || url;
      const text = md.length > maxLen ? `${md.slice(0, maxLen)}…` : md;
      return {
        ok: true,
        url,
        title: cleanCaptureTitle(titleGuess),
        text,
        method: "github-raw",
        wordCount: wordCount(text),
        truncated: md.length > maxLen,
      };
    }

    // Generic HTML page → meta + heuristic Markdown.
    const meta = extractMeta(r.text);
    const text = htmlToMarkdown(r.text, maxLen);
    const rawTitle = meta.og_title || meta.title || "";
    return {
      ok: true,
      url,
      title: cleanCaptureTitle(rawTitle, meta.og_sitename || meta.og_siteName),
      text,
      siteName: meta.og_sitename || meta.og_siteName || undefined,
      author: meta.author || undefined,
      image: meta.og_image || null,
      method: "heuristic",
      wordCount: wordCount(text),
      truncated: text.endsWith("…"),
    };
  } catch (err) {
    return {
      ok: false,
      url,
      title: "",
      text: "",
      method: "heuristic",
      wordCount: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
