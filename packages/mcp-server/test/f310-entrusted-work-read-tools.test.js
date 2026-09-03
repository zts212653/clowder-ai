import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

describe('F310 entrusted-work owner-read MCP projection', () => {
  test('registers one read-only tool without a caller-supplied producer filter', async () => {
    const [{ CANONICAL_TOOL_REGISTRY }, { readEntrustedWorkInputSchema }] = await Promise.all([
      import('../dist/canonical-server-tools.js'),
      import('../dist/tools/entrusted-work-read-tools.js'),
    ]);
    const tool = CANONICAL_TOOL_REGISTRY.find((candidate) => candidate.name === 'cat_cafe_read_entrusted_work');
    assert.ok(tool);
    assert.equal(tool.operation.action, 'read');
    assert.equal(Object.hasOwn(readEntrustedWorkInputSchema, 'producerSubjects'), false);

    const parsed = z.object(readEntrustedWorkInputSchema).safeParse({
      taskId: 'task-1',
      observedRevision: 7,
    });
    assert.equal(parsed.success, true);

    const callerInjectedProducer = z
      .object(readEntrustedWorkInputSchema)
      .strict()
      .safeParse({
        taskId: 'task-1',
        producerSubjects: [{ producerId: 'f306.runtime-interaction', subjectRef: 'interaction-1' }],
      });
    assert.equal(callerInjectedProducer.success, false);
  });
});
