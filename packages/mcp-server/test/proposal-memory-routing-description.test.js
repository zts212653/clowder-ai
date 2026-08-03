import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Profile and Taste proposal descriptions have mutually exclusive semantic ownership', () => {
  test('Profile is about the authenticated person/relationship, not quality taste or repeated workflow rules', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_propose_profile_update');

    assert.ok(tool);
    assert.match(tool.description, /durable.*(person|relationship)|person.*relationship/i);
    assert.match(tool.description, /NOT for.*cat_cafe_propose_taste/i);
    assert.match(tool.description, /code-as-harness/i);
    assert.match(tool.description, /correction.*does not|praise.*does not/i);
  });

  test('Taste is about reusable quality judgment, not personal facts or enforceable workflow rules', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_propose_taste');

    assert.ok(tool);
    assert.match(tool.description, /reusable.*judgment|judgment.*reusable/i);
    assert.match(tool.description, /NOT for.*cat_cafe_propose_profile_update/i);
    assert.match(tool.description, /code-as-harness/i);
    assert.match(tool.description, /correction.*does not|praise.*does not/i);
  });

  test('Entity accepts verified workspace aliases without a nudge while rejecting bare-name guesses and private facts', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((candidate) => candidate.name === 'cat_cafe_propose_entity');

    assert.ok(tool);
    assert.match(tool.description, /verified.*workspace.*(name|handle|alias)/i);
    assert.match(tool.description, /provenance/i);
    assert.match(tool.description, /NOT for.*(unverified|bare).*(proper )?(name|noun)/i);
    assert.match(tool.description, /cat_cafe_propose_person_memory/i);
    assert.match(tool.description, /proposalId.*Approval Hub|Approval Hub.*proposalId/i);
  });
});
