import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Profile and Taste proposal descriptions have mutually exclusive semantic ownership', () => {
  test('remember routes by semantic content and keeps the entity lane narrow', async () => {
    const { z } = await import('zod');
    const { rememberTools } = await import('../dist/tools/remember-tool.js');
    const tool = rememberTools[0];
    assert.match(tool.description, /semantic content/i);
    assert.match(tool.description, /correction, praise or Magic Word does not choose/i);
    assert.match(tool.description, /NOT for repeated operational\/tool\/process rules \(use code-as-harness\)/i);
    const branch = (target) =>
      z.object(tool.inputSchema).shape.items.element.options.find((option) => option.shape.target.value === target)
        .shape.payload.description;
    assert.match(branch('profile'), /durable.*(person|relationship)/i);
    assert.match(branch('taste'), /reusable judgment/i);
    assert.match(branch('taste'), /target \{sourceAnchor, expectedRevision, reason, suggestedPatch\}/);
    const entity = branch('entity');
    assert.match(entity, /verified.*(name|handle|alias)/i);
    assert.match(entity, /provenance/i);
    assert.match(entity, /Not for an unverified bare name/i);
    assert.match(entity, /owner-private facts about a person \(use person\)/i);
  });
});
