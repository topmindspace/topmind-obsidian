import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledSkills, bundledSkillResource } from '../src/services/skill-resources.ts';
import { runAgentTool } from '../src/services/workspace-agent-tools.ts';
test('the standalone plugin discovers skills and resolves their shared rules without sibling repositories', async () => {
  const ctx = { kernel: {}, workspaceRoot: '/nonexistent', engineRoot: '/nonexistent' };
  const skills = await runAgentTool(ctx, { tool: 'list_skills' });
  assert.equal(skills.skills.length, 8);
  for (const skill of bundledSkills()) {
    const body = await runAgentTool(ctx, { tool: 'load_skill', skillId: skill.id });
    assert.equal(body.ok, true, skill.id);
    assert.match(body.content, /name:/);
    for (const match of body.content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      if (/^(https?:|mailto:|\/)/u.test(match[1])) continue;
      assert.notEqual(bundledSkillResource(match[1], skill.id), null, `${skill.id}: ${match[1]}`);
    }
  }
  const resource = await runAgentTool(ctx, { tool: 'load_skill_resource', skillId: 'topmind-write', path: '../shared/writeback-receipt.md' });
  assert.equal(resource.ok, true);
  assert.ok(resource.content.length > 100);
  assert.equal(bundledSkillResource('../../etc/passwd', 'topmind'), null);
  assert.equal(bundledSkillResource('SKILL.md', '../topmind'), null);
});
