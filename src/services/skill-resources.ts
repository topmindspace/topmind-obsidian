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
  if (!relative || path.isAbsolute(relative) || relative.includes("\\")) return null;
  const root = path.resolve("/topmind-bundled-skills");
  const selected = skillId && writing.skills.some(skill => skill.id === skillId) ? writing : pack;
  if (skillId && !selected.skills.some(skill => skill.id === skillId)) return null;
  const absolute = path.resolve(root, skillId || "", relative);
  const key = path.relative(root, absolute).replace(/\\/gu, "/");
  if (key === ".." || key.startsWith("../") || path.isAbsolute(key)) return null;
  return (selected.resources as Record<string, string>)[key] ?? null;
}
