import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { webDigestTemplate } from '../dist/infrastructure/scheduler/templates/web-digest.js';

describe('webDigestTemplate', () => {
  it('gate returns run:true with thread workItem when url + deliveryThreadId set', async () => {
    const spec = webDigestTemplate.createSpec('wd-1', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com', topic: 'AI' },
      deliveryThreadId: 'th-1',
    });
    const result = await spec.admission.gate({ taskId: 'wd-1', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    assert.equal(result.workItems[0].subjectKey, 'thread-th-1');
  });

  it('gate returns run:false when no url param', async () => {
    const spec = webDigestTemplate.createSpec('wd-2', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: {},
      deliveryThreadId: 'th-1',
    });
    const result = await spec.admission.gate({ taskId: 'wd-2', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate returns run:false when no deliveryThreadId', async () => {
    const spec = webDigestTemplate.createSpec('wd-3', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com' },
      deliveryThreadId: null,
    });
    const result = await spec.admission.gate({ taskId: 'wd-3', lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('execute fetches content and delivers digest', async () => {
    const deliverMock = mock.fn(async () => 'msg-1');
    const fetchMock = mock.fn(async () => ({
      text: 'Article about AI advances in 2026',
      title: 'AI News Daily',
      url: 'https://example.com',
      method: 'server-fetch',
      truncated: false,
    }));
    const spec = webDigestTemplate.createSpec('wd-4', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com', topic: 'AI' },
      deliveryThreadId: 'th-1',
    });
    await spec.run.execute(null, 'thread-th-1', {
      assignedCatId: 'opus',
      deliver: deliverMock,
      fetchContent: fetchMock,
    });
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://example.com');
    assert.equal(deliverMock.mock.calls.length, 1);
    const delivered = deliverMock.mock.calls[0].arguments[0];
    assert.ok(delivered.content.includes('AI News Daily'));
    assert.equal(delivered.threadId, 'th-1');
  });

  it('execute skips delivery when fetchContent returns needs-browser', async () => {
    const deliverMock = mock.fn(async () => 'msg-2');
    const triggerCalls = [];
    const fetchMock = mock.fn(async () => ({
      text: '',
      title: '',
      url: 'https://x.com/user',
      method: 'browser',
      truncated: false,
    }));
    const spec = webDigestTemplate.createSpec('wd-5', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://x.com/user', topic: 'AI', targetCatId: 'gpt52' },
      deliveryThreadId: 'th-2',
    });
    await spec.run.execute(null, 'thread-th-2', {
      assignedCatId: 'opus',
      deliver: deliverMock,
      fetchContent: fetchMock,
      invokeTrigger: { trigger: (...args) => triggerCalls.push(args) },
    });

    assert.equal(deliverMock.mock.calls.length, 1);
    const delivered = deliverMock.mock.calls[0].arguments[0];
    assert.equal(delivered.threadId, 'th-2');
    assert.equal(delivered.userId, 'default-user');
    assert.ok(delivered.content.includes('browser-automation'));
    assert.ok(delivered.content.includes('https://x.com/user'));
    assert.ok(delivered.content.includes('AI'));

    // Admission is the wake: the envelope names the member and carries the skill hint.
    assert.equal(delivered.targetCatId, 'gpt52');
    assert.equal(delivered.suggestedSkill, 'browser-automation');
    assert.equal(delivered.sourceCategory, 'scheduled');
  });

  // There is no separate trigger seam left to be missing: the browser-required digest is delivered
  // as one envelope whose admission wakes the member.
  it('delivers the browser-required digest without needing a separate trigger seam', async () => {
    const deliverMock = mock.fn(async () => 'msg-2');
    const fetchMock = mock.fn(async () => ({
      text: '',
      title: '',
      url: 'https://x.com/user',
      method: 'browser',
      truncated: false,
    }));
    const spec = webDigestTemplate.createSpec('wd-5b', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://x.com/user', topic: '' },
      deliveryThreadId: 'th-2',
    });
    await spec.run.execute(null, 'thread-th-2', {
      assignedCatId: 'opus',
      deliver: deliverMock,
      fetchContent: fetchMock,
    });
    assert.equal(deliverMock.mock.calls.length, 1);
    assert.equal(deliverMock.mock.calls[0].arguments[0].targetCatId, 'opus');
  });

  it('execute throws when deliver is not available', async () => {
    const fetchMock = mock.fn(async () => ({
      text: 'content',
      title: 'T',
      url: 'u',
      method: 'server-fetch',
      truncated: false,
    }));
    const spec = webDigestTemplate.createSpec('wd-6', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com' },
      deliveryThreadId: 'th-1',
    });
    await assert.rejects(
      () => spec.run.execute(null, 'thread-th-1', { assignedCatId: null, fetchContent: fetchMock }),
      /deliver not available/,
    );
  });

  it('execute throws when fetchContent is not available', async () => {
    const deliverMock = mock.fn(async () => 'msg-x');
    const spec = webDigestTemplate.createSpec('wd-7', {
      trigger: { type: 'cron', expression: '0 9 * * *' },
      params: { url: 'https://example.com' },
      deliveryThreadId: 'th-1',
    });
    await assert.rejects(
      () => spec.run.execute(null, 'thread-th-1', { assignedCatId: null, deliver: deliverMock }),
      /fetchContent not available/,
    );
  });
});
