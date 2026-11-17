import path from "node:path";
import pack from "../data/skill-pack.json" with { type: "json" };
import writing from "../data/writing-pack.json" with { type: "json" };

export function bundledSkills() {
  return [
    ...pack.skills.map(skill => ({ ...skill, packId: "topmind", path: `${skill.id}/SKILL.md`, version: pack.version })),
    ...writing.skills.map(skill => ({ ...skill, path: `${skill.id}/SKILL.md`, packVersion: writing.version })),
  ];
}

/** Only reviewed snapshot resources are readable; relative links resolve from the activating skill. */
export function bundledSkillResource(relative: string, skillId?: string): string | null {
  const cleaned = relative.replace(/\\/gu, "/");
  if (!cleaned || path.posix.isAbsolute(cleaned) || /^[A-Za-z]:/u.test(cleaned)) return null;
  if (!skillId && cleaned.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(cleaned);
  const prefix = normalized.split("/")[0];
  const selected = writing.skills.some(skill => skill.id === (skillId || prefix)) ? writing : pack;
  if (skillId && !selected.skills.some(skill => skill.id === skillId)) return null;
  const packRelative = !skillId || [skillId, "shared", "runtime"].includes(prefix);
  const key = packRelative ? normalized : path.posix.join(skillId, cleaned);
  const resources = selected.resources as Record<string, string>;
  return Object.hasOwn(resources, key) ? resources[key] : null;
}
