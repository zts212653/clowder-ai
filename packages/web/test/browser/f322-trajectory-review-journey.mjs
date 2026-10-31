import assert from 'node:assert/strict';
import { detail, summary } from './f322-trajectory-data.mjs';

export async function runTrajectoryReviewRegressions({ open, resize, snapshot }) {
  // Open labels and ordinary verb/ID candidates share the same honest state.
  const samples = [
    ['1. 先检查日志。下一句。', '1.', 'boundary_unconfirmed'],
    ['Dr. Smith checked the issue. Next sentence.', 'Dr.', 'boundary_unconfirmed'],
    ['You，', 'You，', 'boundary_unconfirmed'],
    ['ii. Check the logs. Next sentence.', 'ii.', 'boundary_unconfirmed'],
    ['## 1. Check logs. Next sentence.', '## 1.', 'boundary_unconfirmed'],
    ['> ## **1. Check logs. Next sentence.', '> ## **1.', 'boundary_unconfirmed'],
    ['[1]. Check logs. Next.', '[1].', 'boundary_unconfirmed'],
    ['The value is 1. Next.', 'The value is 1.', 'boundary_unconfirmed'],
    ...[
      'Step 1.',
      'Option A.',
      'Stage 1.',
      '步骤 1.',
      '自定义标签 IV.',
      'Use A1.',
      'Choose B.',
      'Found 2.',
      'Task A1 IV.',
      'Iteration IV 2.',
      'ZebraLabel A1.',
    ].map((candidate) => [`${candidate} Next sentence.`, candidate, 'boundary_unconfirmed']),
    ['好。下一句。', '好。', 'sentence'],
    ['I did. Next sentence.', 'I did.', 'sentence'],
    ['检查了3个文件。下一句。', '检查了3个文件。', 'sentence'],
    ['GPT5好了。下一句。', 'GPT5好了。', 'sentence'],
    [
      'The first native response fully explains the observed issue. Later.',
      'The first native response fully explains the observed issue.',
      'sentence',
    ],
  ];
  for (const [index, [content, expected, kind]] of samples.entries()) {
    const currentSummary = {
      ...summary,
      firstAssistantOutputEvidence: {
        ...summary.firstAssistantOutputEvidence,
        content,
        byteLength: Buffer.byteLength(content, 'utf8'),
      },
    };
    const currentDetail = {
      ...detail,
      summary: currentSummary,
      events: detail.events.map((envelope) =>
        envelope.eventNo === 103 ? { ...envelope, event: { ...envelope.event, content } } : envelope,
      ),
    };
    const { page, context, panel, errors, calls } = await open('v2', 'light', {
      summary: currentSummary,
      detail: currentDetail,
    });
    try {
      await resize(page, 300);
      const preview = panel.getByTestId('first-assistant-preview');
      assert.equal(await preview.getAttribute('data-preview-kind'), kind);
      assert.equal(await preview.getByTestId('first-assistant-preview-content').innerText(), expected);
      const label = preview.getByTestId('first-assistant-preview-label');
      if (kind === 'boundary_unconfirmed') {
        assert.equal(await label.innerText(), '首句边界未确认');
        assert.doesNotMatch(await preview.innerText(), /完整首句/);
      } else {
        assert.equal(await label.count(), 0);
      }
      assert.equal(
        calls.some((call) => call.includes('/sessions/') && call.includes('/invocations/')),
        false,
      );
      assert.deepEqual(errors, []);
      await snapshot(`r1-prefix-${index}`, page);
    } finally {
      await context.close();
    }
  }
  const outputMessage = {
    ...summary.firstAssistantOutputEvidence.identity,
    channel: 'commentary',
    complete: false,
    textMode: 'append',
  };
  const frame = detail.events[101];
  const events = [
    { type: 'text', content: '角色边界前文', outputMessage },
    { type: 'text', role: 'tool', content: '非法角色正文仅原始记录保留', outputMessage },
    { type: 'assistant', role: 'user', content: '冲突角色正文仅原始记录保留', outputMessage },
    { type: 'text', content: '角色边界后文。', outputMessage: { ...outputMessage, complete: true } },
  ].map((event, eventNo) => ({ ...frame, eventNo, t: 1000 + eventNo, event }));
  const currentSummary = {
    ...summary,
    eventCount: 4,
    toolUseCount: 0,
    toolResultCount: 0,
    statusEventCount: 0,
    messageCount: 4,
    errorCount: 0,
    toolNames: [],
    firstAssistantOutputEvidence: {
      role: 'assistant',
      status: 'conflict',
      complete: false,
      byteLength: 100,
      source: {
        sessionId: summary.sessionId,
        invocationId: summary.invocationId,
        firstEventNo: 0,
        lastEventNo: 3,
        eventCount: 2,
      },
    },
  };
  const { page, context, panel, errors } = await open('v2', 'light', {
    summary: currentSummary,
    detail: { ...detail, summary: currentSummary, events, total: 4 },
  });
  try {
    await resize(page, 300);
    await panel.locator('article > button').first().click();
    const current = page.getByTestId('invocation-trajectory-detail');
    await current.getByText('角色边界后文。', { exact: true }).waitFor();
    const cards = current.locator('[data-semantic-role="assistant"]');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.first().locator('span').last().innerText(), '角色边界前文');
    assert.doesNotMatch(await current.innerText(), /非法角色正文|冲突角色正文/);
    await snapshot('r1-role-detail', page);
    await current.getByRole('button', { name: '原始记录', exact: true }).click();
    assert.match(await current.innerText(), /非法角色正文仅原始记录保留/);
    assert.match(await current.innerText(), /冲突角色正文仅原始记录保留/);
    await snapshot('r1-role-raw', page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
