import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CollectivePrivateWorkRefusalError } from '../src/domains/cats/services/agents/invocation/collective-private-refusal.js';
import {
  type InvocationDeps,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';

test('private admission wraps only exact permanent Host refusals; a transport failure stays retryable and no provider starts', async () => {
  let starts = 0;
  const service = {
    async *invoke() {
      starts++;
    },
  };
  const params = {
    catId: createCatId('codex-sol'),
    service,
    userId: 'owner',
    threadId: 'private-A',
    executionScope: 'collective-work' as const,
    prompt: 'hostile content',
    isLastCat: true,
  };
  for (const code of ['WORK_EXECUTION_NOT_CURRENT', 'OWNER_ADMISSION_UNAVAILABLE', 'ECONNRESET']) {
    const original = Object.assign(new Error(code), { code });
    const deps = {
      collectiveContext: () => ({
        async resolvePrivate() {
          throw original;
        },
      }),
    } as unknown as InvocationDeps;
    await assert.rejects(
      async () => {
        for await (const _event of invokeSingleCat(deps, params)) {
        }
      },
      (error: unknown) => {
        if (code === 'ECONNRESET') {
          assert.equal(error, original);
          return true;
        }
        assert.ok(error instanceof CollectivePrivateWorkRefusalError);
        assert.equal(
          error.reason,
          code === 'WORK_EXECUTION_NOT_CURRENT' ? 'work_execution_not_current' : 'owner_admission_unavailable',
        );
        return true;
      },
    );
  }
  assert.equal(starts, 0);
});

test('an unsupported named private provider is a typed carrier refusal before auth or model launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-provider-refusal-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  let starts = 0;
  const deps = {
    collectiveContext: () => ({
      async resolvePrivate() {
        return { work: { task: { id: 'A' }, executionRevision: 1, authorityRef: 'message:admission-A' } };
      },
    }),
  } as unknown as InvocationDeps;
  try {
    await assert.rejects(
      async () => {
        for await (const _event of invokeSingleCat(deps, {
          catId: createCatId('codex-sol'),
          service: {
            supportsToolExecutionPolicy: () => false,
            async *invoke() {
              starts++;
            },
          },
          userId: 'owner',
          threadId: 'private-A',
          executionScope: 'collective-work',
          prompt: 'A',
          isLastCat: true,
        })) {
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof CollectivePrivateWorkRefusalError);
        assert.equal(error.reason, 'private_provider_unsupported');
        return true;
      },
    );
    assert.equal(starts, 0);
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
