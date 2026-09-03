import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVAL_METRIC_GLOSSARY_CHECK_NAME,
  publishVerdictCommitStatuses,
} from '../../dist/infrastructure/harness-eval/publish-verdict/publication/verdict-commit-status-publisher.js';

describe('verdict commit status publisher', () => {
  it('posts the exact successful glossary context to the published verdict commit', async () => {
    const calls = [];
    await publishVerdictCommitStatuses(
      {
        repoFullName: 'zts212653/cat-cafe',
        headSha: 'a'.repeat(40),
        statuses: [
          {
            context: EVAL_METRIC_GLOSSARY_CHECK_NAME,
            state: 'success',
            description: 'Candidate glossary, measurement, and publication contracts passed',
          },
        ],
      },
      async (args) => calls.push(args),
    );

    assert.equal(EVAL_METRIC_GLOSSARY_CHECK_NAME, 'Eval Metric Glossary Coverage');
    assert.deepEqual(calls, [
      [
        'api',
        '--method',
        'POST',
        `repos/zts212653/cat-cafe/statuses/${'a'.repeat(40)}`,
        '--raw-field',
        'state=success',
        '--raw-field',
        'context=Eval Metric Glossary Coverage',
        '--raw-field',
        'description=Candidate glossary, measurement, and publication contracts passed',
      ],
    ]);
  });

  it('rejects unsafe repository, SHA, context, and description inputs before invoking gh', async () => {
    const calls = [];
    const runner = async (args) => calls.push(args);
    const valid = {
      repoFullName: 'zts212653/cat-cafe',
      headSha: 'a'.repeat(40),
      statuses: [
        {
          context: EVAL_METRIC_GLOSSARY_CHECK_NAME,
          state: 'success',
          description: 'Candidate glossary, measurement, and publication contracts passed',
        },
      ],
    };
    const invalidInputs = [
      { ...valid, repoFullName: 'zts212653/cat-cafe\n--hostname=evil' },
      { ...valid, headSha: 'HEAD' },
      { ...valid, statuses: [{ ...valid.statuses[0], context: 'bad\ncontext' }] },
      { ...valid, statuses: [{ ...valid.statuses[0], context: 'x'.repeat(101) }] },
      { ...valid, statuses: [{ ...valid.statuses[0], description: 'bad\rdescription' }] },
      { ...valid, statuses: [{ ...valid.statuses[0], description: 'x'.repeat(141) }] },
    ];

    for (const input of invalidInputs) {
      await assert.rejects(publishVerdictCommitStatuses(input, runner), /invalid_verdict_status_/);
    }
    assert.equal(calls.length, 0);
  });
});
