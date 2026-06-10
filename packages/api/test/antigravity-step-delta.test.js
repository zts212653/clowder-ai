import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffDeliveredSteps } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-step-delta.js';

describe('diffDeliveredSteps', () => {
  for (const [label, toolFields] of [
    ['metadata.toolCall', { metadata: { toolCall: { name: 'grep_search', argumentsJson: '{"Query":"foo"}' } } }],
    ['mcpTool.toolCall', { mcpTool: { toolCall: { name: 'read_file', argumentsJson: '{"path":"docs/example.md"}' } } }],
  ]) {
    test(`F211-REG13: ${label} in-place update replays delivered tool step`, () => {
      const initialStep = {
        type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
        status: 'CORTEX_STEP_STATUS_WAITING',
      };
      const seeded = diffDeliveredSteps([initialStep], 0, [], []);

      const updatedStep = { ...initialStep, ...toolFields };
      const diff = diffDeliveredSteps([updatedStep], 1, seeded.nextFingerprints, seeded.nextPlannerTexts);

      assert.equal(diff.hadMutation, true);
      assert.equal(diff.replaySteps.length, 1);
      assert.deepEqual(diff.replaySteps[0], updatedStep);
    });
  }

  test('F211-REG13: direct toolCall replays when metadata arguments arrive later', () => {
    const initialStep = {
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      status: 'CORTEX_STEP_STATUS_WAITING',
      toolCall: { toolName: 'grep_search' },
    };
    const seeded = diffDeliveredSteps([initialStep], 0, [], []);

    const updatedStep = {
      ...initialStep,
      metadata: { toolCall: { argumentsJson: '{"Query":"mixed-shape"}' } },
    };
    const diff = diffDeliveredSteps([updatedStep], 1, seeded.nextFingerprints, seeded.nextPlannerTexts);

    assert.equal(diff.hadMutation, true);
    assert.equal(diff.replaySteps.length, 1);
    assert.deepEqual(diff.replaySteps[0], updatedStep);
  });
});
