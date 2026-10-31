#!/usr/bin/env node
// Refresh the reviewed portable skill snapshot; normal builds use the committed snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '../topmind-skills');
const output = path.join(root, 'src/data/skill-pack.json');
const ids = ['topmind', 'topmind-capture', 'topmind-organize', 'topmind-write', 'topmind-memory', 'topmind-maintain', 'topmind-loop', 'topmind-ledger'];
if (!fs.existsSync(path.join(source, 'topmind-pack.json'))) throw new Error('Canonical sibling topmind-skills source is required for an explicit snapshot refresh');
const resources = {};
function walk(dir, relative) {
 for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
  if (entry.isSymbolicLink()) throw new Error(`Symlink in skill source: ${relative}/${entry.name}`);
  const rel = `${relative}/${entry.name}`;
  if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
  else if (entry.isFile() && entry.name.endsWith('.md')) resources[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
 }
}
for (const id of [...ids, 'shared']) walk(path.join(source, id), id);
const skills = ids.map(id => {
 const fm = resources[`${id}/SKILL.md`]?.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
 const meta = parse(fm || '');
 if (!meta?.name || !meta.description) throw new Error(`Invalid skill frontmatter: ${id}`);
 return { id, name: meta.name, description: meta.description };
});
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'topmind-pack.json'), 'utf8'));
fs.writeFileSync(output, JSON.stringify({ version: manifest.version, source: manifest.repository.url, license: manifest.license, skills, resources }, null, 2) + '\n');
const writingSource = path.resolve(root, process.env.TOPMIND_WRITING_SRC || '../topmind-writing-skills');
const { buildHostPack } = createRequire(import.meta.url)(path.join(writingSource, 'lib/host-pack.cjs'));
const { snapshot } = buildHostPack(writingSource);
fs.writeFileSync(path.join(root, 'src/data/writing-pack.json'), JSON.stringify(snapshot) + '\n');
const runtimeDir = path.join(root, 'src/generated/writing');
fs.mkdirSync(runtimeDir, { recursive: true });
for (const key of Object.keys(snapshot.resources).filter(name => /^runtime\/[^/]+\.(?:mjs|mts)$/u.test(name)).sort()) {
  fs.writeFileSync(path.join(runtimeDir, key.slice('runtime/'.length)), snapshot.resources[key]);
}
console.log(`Synced independent writing pack ${snapshot.version}, ${snapshot.skills.length} skills (${snapshot.digest})`);
console.log(`Synced ${skills.length} skills and ${Object.keys(resources).length} Markdown resources (${fs.statSync(output).size} bytes)`);
