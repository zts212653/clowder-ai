import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

describe('F310 entrusted-work MCP owner actions', () => {
  test('registers typed admission and closure tools over the shared contract', async () => {
    const {
      admitEntrustedWorkInputSchema,
      callbackTools,
      closeEntrustedWorkInputSchema,
      updateEntrustedWorkInputSchema,
    } = await import('../dist/tools/callback-tools.js');
    const admitTool = callbackTools.find((tool) => tool.name === 'cat_cafe_admit_entrusted_work');
    const closeTool = callbackTools.find((tool) => tool.name === 'cat_cafe_close_entrusted_work');
    const updateTool = callbackTools.find((tool) => tool.name === 'cat_cafe_update_entrusted_work');

    assert.ok(admitTool);
    assert.ok(closeTool);
    assert.ok(updateTool);
    assert.equal(admitTool.handler.name, 'handleAdmitEntrustedWork');
    assert.equal(closeTool.handler.name, 'handleCloseEntrustedWork');
    assert.equal(updateTool.handler.name, 'handleUpdateEntrustedWork');
    assert.deepEqual(updateTool.policy.runtimeProfiles, ['full']);

    const admit = z.object(admitEntrustedWorkInputSchema).safeParse({
      title: 'Prepare tomorrow presentation',
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:source-1'],
        intendedOutcome: 'A reviewable presentation is ready',
        idempotencyKey: 'entrusted:source-1',
      },
      closure: {
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
      },
    });
    assert.equal(admit.success, true);

    const acceptedWithoutSourceCoordinates = z.object(admitEntrustedWorkInputSchema).safeParse({
      title: 'Prepare tomorrow presentation',
      admission: {
        basis: 'accepted_offer',
        sourceRefs: ['message:source-1'],
        intendedOutcome: 'A reviewable presentation is ready',
        idempotencyKey: 'entrusted:source-1',
      },
      closure: {
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
      },
    });
    assert.equal(acceptedWithoutSourceCoordinates.success, false);

    const invalidClose = z.object(closeEntrustedWorkInputSchema).safeParse({
      taskId: 'task-1',
      expectedRevision: 1,
      closure: {
        state: 'satisfied',
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
        evidenceRefs: [],
      },
    });
    assert.equal(invalidClose.success, false);

    const update = z.object(updateEntrustedWorkInputSchema).safeParse({
      taskId: 'task-1',
      expectedRevision: 1,
      time: { reviewBy: null },
      artifactRefs: ['artifact:ppt:final'],
    });
    assert.equal(update.success, true);

    const { entrustedWorkUpdateActionV1Schema } = await import('@cat-cafe/shared');
    for (const candidate of [
      { taskId: 'task-1', expectedRevision: 1, artifactRefs: ['artifact:ppt:final'] },
      { taskId: 'task-1', expectedRevision: 1, time: { reviewBy: null } },
      { taskId: 'task-1', expectedRevision: 0, artifactRefs: [] },
      { taskId: 'task-1', expectedRevision: 1, time: { reviewBy: { value: -1, sourceRef: 'message:1' } } },
    ]) {
      assert.equal(
        z.object(updateEntrustedWorkInputSchema).strict().safeParse(candidate).success,
        entrustedWorkUpdateActionV1Schema.safeParse(candidate).success,
      );
    }
  });

  test('registers a source-bound implicit offer and same-key clarification retry without a generic router', async () => {
    const { callbackTools, offerCustodyInputSchema, retryCustodyAdmissionInputSchema } = await import(
      '../dist/tools/callback-tools.js'
    );
    const offer = callbackTools.find((tool) => tool.name === 'cat_cafe_offer_custody');
    const retry = callbackTools.find((tool) => tool.name === 'cat_cafe_retry_custody_admission');

    assert.ok(offer);
    assert.ok(retry);
    assert.match(offer.description, /Use when:/);
    assert.match(offer.description, /NOT for:/);
    assert.match(offer.description, /Output:/);
    assert.match(offer.description, /GOTCHA:/);
    assert.equal(offer.handler.name, 'handleOfferCustody');
    assert.equal(retry.handler.name, 'handleRetryCustodyAdmission');

    assert.equal(
      z.object(offerCustodyInputSchema).safeParse({
        sourceMessageId: 'message-1',
        reasonCode: 'future_deliverable',
      }).success,
      true,
    );
    assert.equal(
      z.object(offerCustodyInputSchema).safeParse({
        sourceMessageId: 'message-1',
        reasonCode: 'venting',
      }).success,
      false,
    );
    assert.equal(
      z.object(retryCustodyAdmissionInputSchema).safeParse({
        sourceMessageId: 'message-1',
        sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
        offerId: 'custody-offer:message-1',
        title: 'Prepare the presentation',
        intendedOutcome: 'A reviewable presentation is ready',
        closure: {
          condition: 'The presentation is ready for review',
          expectedSignal: 'artifact:final-presentation',
        },
      }).success,
      true,
    );
  });
});
