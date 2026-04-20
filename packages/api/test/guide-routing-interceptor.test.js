import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('GuideRoutingInterceptor', async () => {
  const { prepareGuideContext } = await import('../dist/domains/guides/GuideRoutingInterceptor.js');

  test('resumes existing structured guide state for the same user', async () => {
    const ctx = await prepareGuideContext({
      thread: {
        id: 'test-thread',
        createdBy: 'test-user',
        guideState: {
          v: 1,
          guideId: 'add-member',
          status: 'offered',
          userId: 'test-user',
          offeredAt: Date.now(),
          offeredBy: 'opus',
        },
      },
      targetCats: ['opus'],
      message: '继续',
      userId: 'test-user',
      threadId: 'test-thread',
    });

    assert.equal(ctx.candidate?.id, 'add-member');
    assert.equal(ctx.candidate?.status, 'offered');
    assert.equal(ctx.candidate?.isNewOffer, false);
  });

  test('plain keyword-containing message does not auto-resolve a guide candidate', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '请帮我添加成员',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.equal(ctx.candidate, undefined);
  });

  test('/guide add-member no longer resolves via direct ID lookup', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '/guide add-member',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.equal(ctx.candidate, undefined);
  });

  test('引导 添加成员 no longer resolves via explicit natural-language command', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '引导 添加成员',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.equal(ctx.candidate, undefined);
  });

  test('bare /guide does not crash or match', async () => {
    const ctx = await prepareGuideContext({
      thread: null,
      targetCats: ['opus'],
      message: '/guide',
      userId: 'test-user',
      threadId: 'test-thread',
    });
    assert.equal(ctx.candidate, undefined);
  });
});
