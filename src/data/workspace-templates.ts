// ── Embedded workspace templates ───────────────────────────────────────────
//
// Community plugin installs only download main.js + manifest.json + styles.css.
// templates/ on disk is therefore optional at runtime; these objects are
// bundled into main.js so first-init and locale seeding work after a clean
// community install. Disk copies (when present, e.g. manual zip) still win so
// engine-side template updates remain pick-up-able without a plugin rebuild.
//
// Pure TS (not JSON imports) so `node --experimental-strip-types` tests can
// import this module without a JSON loader.

export interface WorkspaceTemplateCategories {
  [slot: string]: {
    name: string;
    role?: string;
    required?: boolean;
    specialBehavior?: string;
  };
}

export interface WorkspaceTemplate {
  templateId?: string;
  version?: string;
  name?: string;
  description?: string;
  categories?: WorkspaceTemplateCategories;
  stream?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  connectorHints?: Record<string, unknown>;
  defaultViews?: string[];
  separator?: string;
  [key: string]: unknown;
}

const stream: WorkspaceTemplate = {
  templateId: "stream",
  version: "4.0.0",
  name: "极简流式（默认）",
  description:
    "最少心智：Inbox、动态（流水）、专题、交付、归档。日常默认按周记在一本上，适合大多数个人场景。",
  categories: {
    "00": { name: "Inbox", role: "buffer", required: true },
    "10": { name: "动态", role: "loose-stream", specialBehavior: "flat-default" },
    "20": { name: "专题", role: "deep-work" },
    "88": { name: "交付", role: "delivery", required: true },
    "99": { name: "归档", role: "system", required: true },
  },
  stream: { packing: "weekly", appendHeading: "day", yearDir: true },
  memory: { dir: "memory", profileFile: "profile.md" },
  connectorHints: {
    weread: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "阅读", "读书"] },
    x: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "social", "素材"] },
  },
  defaultViews: ["stream", "category", "timeline"],
  separator: "-",
};

const streamEn: WorkspaceTemplate = {
  templateId: "stream",
  name: "Stream (Default)",
  description:
    "Minimal friction: Inbox, Stream (Journal), Topics, Delivery, Archive. Daily entries stream weekly.",
  categories: {
    "00": { name: "Inbox" },
    "10": { name: "Stream" },
    "20": { name: "Topics" },
    "88": { name: "Delivery" },
    "99": { name: "Archive" },
  },
  memory: { profileFile: "profile.md" },
};

const balanced: WorkspaceTemplate = {
  templateId: "balanced",
  version: "4.0.0",
  name: "平衡知识型",
  description: "适合知识工作者：动态、专题，兼顾低摩擦记录与知识沉淀。",
  categories: {
    "00": { name: "Inbox", role: "buffer", required: true },
    "10": { name: "动态", role: "loose-stream", specialBehavior: "flat-default" },
    "20": { name: "专题", role: "deep-work" },
    "88": { name: "交付", role: "delivery", required: true },
    "99": { name: "归档", role: "system", required: true },
  },
  stream: { packing: "weekly", appendHeading: "day", yearDir: true },
  memory: { dir: "memory", profileFile: "profile.md" },
  connectorHints: {
    weread: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "阅读", "读书"] },
    x: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "social", "素材"] },
  },
  defaultViews: ["stream", "category", "timeline", "tags"],
  separator: "-",
};

const balancedEn: WorkspaceTemplate = {
  templateId: "balanced",
  name: "Balanced Knowledge",
  description:
    "For knowledge workers: Stream, Topics, balancing low-friction capture with knowledge consolidation.",
  categories: {
    "00": { name: "Inbox" },
    "10": { name: "Stream" },
    "20": { name: "Topics" },
    "88": { name: "Delivery" },
    "99": { name: "Archive" },
  },
  memory: { profileFile: "profile.md" },
};

const periodic: WorkspaceTemplate = {
  templateId: "periodic",
  version: "4.0.0",
  name: "周期回顾型",
  description: "同 balanced + 强周期回顾：动态、专题，强调周期复盘与记忆沉淀。",
  categories: {
    "00": { name: "Inbox", role: "buffer", required: true },
    "10": { name: "动态", role: "loose-stream", specialBehavior: "flat-default" },
    "20": { name: "专题", role: "deep-work" },
    "88": { name: "交付", role: "delivery", required: true },
    "99": { name: "归档", role: "system", required: true },
  },
  stream: { packing: "weekly", appendHeading: "day", yearDir: true },
  memory: {
    dir: "memory",
    profileFile: "profile.md",
    layers: { periodic: { cadence: "weekly", autoDigest: true } },
  },
  lifecycle: { stream: { digestAfterPeriods: 1 } },
  connectorHints: {
    weread: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "阅读"] },
    x: { preferSlot: "20", preferRole: "deep-work", nameKeywords: ["专题", "素材"] },
  },
  defaultViews: ["stream", "timeline", "category"],
  separator: "-",
};

const periodicEn: WorkspaceTemplate = {
  templateId: "periodic",
  name: "Periodic Review",
  description:
    "Same as Balanced + strong periodic review: Stream, Topics, emphasizing periodic reflection.",
  categories: {
    "00": { name: "Inbox" },
    "10": { name: "Stream" },
    "20": { name: "Topics" },
    "88": { name: "Delivery" },
    "99": { name: "Archive" },
  },
  memory: { profileFile: "profile.md" },
};

const research: WorkspaceTemplate = {
  templateId: "research",
  version: "4.0.0",
  name: "学术研究型",
  description: "适合深度研究：动态、专题、研究、参考资料，强调来源追踪与深度整理。",
  categories: {
    "00": { name: "Inbox", role: "buffer", required: true },
    "10": { name: "动态", role: "loose-stream", specialBehavior: "flat-default" },
    "20": { name: "专题", role: "deep-work" },
    "30": { name: "研究", role: "deep-work" },
    "40": { name: "参考资料", role: "reference" },
    "88": { name: "交付", role: "delivery", required: true },
    "99": { name: "归档", role: "system", required: true },
  },
  stream: { packing: "weekly", appendHeading: "day", yearDir: true },
  memory: { dir: "memory", profileFile: "profile.md" },
  connectorHints: {
    weread: { preferSlot: "30", preferRole: "deep-work", nameKeywords: ["研究", "文献", "阅读"] },
  },
  defaultViews: ["category", "stream", "tags"],
  separator: "-",
};

const researchEn: WorkspaceTemplate = {
  templateId: "research",
  name: "Academic Research",
  description:
    "For deep research: Stream, Topics, Research, References, emphasizing source tracking.",
  categories: {
    "00": { name: "Inbox" },
    "10": { name: "Stream" },
    "20": { name: "Topics" },
    "30": { name: "Research" },
    "40": { name: "References" },
    "88": { name: "Delivery" },
    "99": { name: "Archive" },
  },
  memory: { profileFile: "profile.md" },
};

const EMBEDDED: Record<string, WorkspaceTemplate> = {
  balanced,
  "balanced.en-US": balancedEn,
  periodic,
  "periodic.en-US": periodicEn,
  research,
  "research.en-US": researchEn,
  stream,
  "stream.en-US": streamEn,
};

/** Resolve a template by id, preferring a locale-specific variant when asked. */
export function resolveEmbeddedTemplate(
  templateId: string,
  locale?: string | null,
): WorkspaceTemplate | null {
  const id = templateId || "stream";
  const wantEn = !!locale && /^en\b/i.test(locale);
  const primary = wantEn ? `${id}.en-US` : id;
  return EMBEDDED[primary] ?? EMBEDDED[id] ?? EMBEDDED[`${id}.en-US`] ?? null;
}

