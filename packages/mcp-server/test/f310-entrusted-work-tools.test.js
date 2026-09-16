import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

describe('F310 entrusted-work MCP owner actions', () => {
  test('typed progress reaches the callback transport without being dropped by the MCP handler', async (t) => {
    const originalFetch = globalThis.fetch;
    const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'];
    const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      globalThis.fetch = originalFetch;
      for (const key of keys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
      }
    });
    process.env.CAT_CAFE_API_URL = 'http://localhost:3102';
    process.env.CAT_CAFE_INVOCATION_ID = 'fixture-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'fixture-callback';
    let forwarded;
    globalThis.fetch = async (_url, options) => {
      forwarded = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: 'updated' }), { status: 200 });
    };
    const { handleUpdateEntrustedWork } = await import('../dist/tools/callback-tools.js');
    await handleUpdateEntrustedWork({ taskId: 'task-1', expectedRevision: 3, status: 'blocked' });
    assert.deepEqual(forwarded, { taskId: 'task-1', expectedRevision: 3, status: 'blocked' });
  });
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

    for (const status of ['todo', 'doing', 'blocked']) {
      const parsed = z.object(updateEntrustedWorkInputSchema).strict().parse({
        taskId: 'task-1',
        expectedRevision: 1,
        status,
      });
      assert.equal(parsed.status, status);
    }

    const { entrustedWorkUpdateActionV1Schema } = await import('@cat-cafe/shared');
    for (const candidate of [
      { taskId: 'task-1', expectedRevision: 1, status: 'doing' },
      { taskId: 'task-1', expectedRevision: 1, status: 'done' },
      { taskId: 'task-1', expectedRevision: 1, status: 'blocked', ownerCatId: 'opus' },
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
