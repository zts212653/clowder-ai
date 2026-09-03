import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSkillConsumptionTools } from '../dist/tools/skill-consumption-tools.js';

test('skill consumption tools prepare revision binding, invoke the real consumer, and dismiss explicitly', async () => {
  const calls = [];
  const callbackPost = async (path, body) => {
    calls.push({ path, body });
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  };
  const toolset = createSkillConsumptionTools(callbackPost);

  await toolset.handlePrepareSkillConsumption({ skillId: 'workspace-navigator' });
  await toolset.handleOpenWithWorkspaceNavigator({
    handle: 'prepared-handle',
    path: 'docs/VISION.md',
    worktreeId: 'cat-cafe',
    line: 12,
    threadId: 'thread-receipt',
  });
  await toolset.handleDismissSkillConsumption({
    handle: 'second-prepared-handle',
    reason: 'outside_skill_scope',
  });

  assert.deepEqual(calls[0], {
    path: '/api/callbacks/skill-consumption/prepare',
    body: { skillId: 'workspace-navigator' },
  });
  assert.deepEqual(calls[1], {
    path: '/api/workspace/navigate',
    body: {
      skillConsumptionHandle: 'prepared-handle',
      path: 'docs/VISION.md',
      action: 'open',
      worktreeId: 'cat-cafe',
      line: 12,
      threadId: 'thread-receipt',
    },
  });
  assert.equal(calls[2].path, '/api/callbacks/skill-consumption/dismiss');
  assert.equal(calls[2].body.handle, 'second-prepared-handle');
  assert.equal(calls[2].body.reason, 'outside_skill_scope');
  assert.deepEqual(
    toolset.tools.map((tool) => tool.name),
    [
      'cat_cafe_prepare_skill_consumption',
      'cat_cafe_open_with_workspace_navigator',
      'cat_cafe_dismiss_skill_consumption',
    ],
  );
  assert.equal(
    toolset.tools.some((tool) => tool.name.includes('apply')),
    false,
    'no self-attested apply setter exists',
  );
});

test('skill consumption tool descriptions refuse task-success causality and unsupported carriers', () => {
  const toolset = createSkillConsumptionTools(async () => ({ content: [] }));
  const combined = toolset.tools.map((tool) => tool.description).join('\n');
  assert.match(combined, /revision/i);
  assert.match(combined, /invocation/i);
  assert.match(combined, /NOT for/i);
  assert.match(combined, /agent-key.*unsupported/i);
  assert.match(combined, /task success/i);
  assert.match(combined, /does not prove.*package.*read/i);
});

test('carrier profile projection exposes receipts only to full invocation MCP', async () => {
  const { buildCollabTools } = await import('../dist/server-toolsets.js');
  const receiptNames = new Set([
    'cat_cafe_prepare_skill_consumption',
    'cat_cafe_open_with_workspace_navigator',
    'cat_cafe_dismiss_skill_consumption',
  ]);
  const projected = (env) => new Set(buildCollabTools(env).map((tool) => tool.name));

  for (const name of receiptNames) assert.equal(projected({ readonly: false }).has(name), true);
  for (const env of [
    { readonly: true },
    { readonly: true, hasAgentKey: true },
    { desktopMode: 'fable-phase0' },
    { desktopMode: 'cloud-pro-phase0' },
  ]) {
    for (const name of receiptNames) {
      assert.equal(projected(env).has(name), false, `${name} must be absent for ${JSON.stringify(env)}`);
    }
  }
});
