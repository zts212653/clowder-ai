import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTasks, toCreateTaskInputs } from '../dist/domains/cats/services/orchestration/TaskExtractor.js';

const message = (id, content, catId = null) => ({ id, content, catId });

describe('explicit task extraction', () => {
  it('extracts all supported markers and preserves the actual source message', () => {
    const result = extractTasks([
      message('m1', 'We need to TODO: implement auth\n- [ ] add login page'),
      message('m2', '#task 修复\nAction Item: review permissions', 'opus'),
    ]);
    assert.equal(result.degraded, false);
    assert.deepEqual(
      result.tasks.map(({ title, sourceMessageId }) => ({ title, sourceMessageId })),
      [
        { title: 'implement auth', sourceMessageId: 'm1' },
        { title: 'add login page', sourceMessageId: 'm1' },
        { title: '修复', sourceMessageId: 'm2' },
        { title: 'review permissions', sourceMessageId: 'm2' },
      ],
    );
    assert.ok(
      result.tasks.every((task) => task.ownerCatId === undefined),
      'markers do not establish assignment',
    );
    assert.equal(result.reason, undefined);
  });

  it('does not turn ordinary discussion or completed checkboxes into tasks', () => {
    assert.deepEqual(
      extractTasks([
        message(
          'm1',
          'We should review the design.\n- [x] finished work\nTODO\nTODO: \nTODO：\nAction Item: \n#task\n- [ ]\n- [x] TODO: finished task\nnotTODO: ordinary text',
        ),
      ]).tasks,
      [],
    );
    assert.deepEqual(extractTasks([]), { tasks: [], degraded: false });
  });

  it('deduplicates repeated and nested markers within a source without merging different sources', () => {
    const result = extractTasks([
      message('m1', '- [ ] TODO: write tests\nTODO: write tests'),
      message('m2', '#task write tests'),
    ]);
    assert.deepEqual(
      result.tasks.map((t) => [t.title, t.sourceMessageId]),
      [
        ['write tests', 'm1'],
        ['write tests', 'm2'],
      ],
    );
  });

  it('handles case, CRLF and the task title storage limit', () => {
    const result = extractTasks([
      message('m1', `todo：回读\r\naction item: Run checks\r\nTODO: ${'x'.repeat(200)}\nTODO: ${'x'.repeat(201)}`),
    ]);
    assert.deepEqual(
      result.tasks.map((t) => t.title),
      ['回读', 'Run checks', 'x'.repeat(200)],
    );
  });

  it('analyzes only the requested recent window', () => {
    const messages = [message('old', 'TODO: old task'), message('new', 'TODO: recent task')];
    assert.deepEqual(
      extractTasks(messages, { maxMessages: 1 }).tasks.map((t) => t.sourceMessageId),
      ['new'],
    );
    assert.deepEqual(extractTasks(messages, { maxMessages: 0 }).tasks, []);
    assert.equal(
      extractTasks(Array.from({ length: 51 }, (_, n) => message(String(n), 'TODO: pending'))).tasks[0].sourceMessageId,
      '1',
    );
  });
});

describe('toCreateTaskInputs', () => {
  it('keeps thread, creator, ownership and source for durable storage', () => {
    assert.deepEqual(
      toCreateTaskInputs(
        [
          { title: 'Task 1', why: 'Reason 1', sourceMessageId: 'm1' },
          { title: 'Task 2', why: 'Reason 2', ownerCatId: 'opus' },
        ],
        'thread-1',
        'user',
      ),
      [
        {
          title: 'Task 1',
          why: 'Reason 1',
          threadId: 'thread-1',
          createdBy: 'user',
          ownerCatId: null,
          sourceMessageId: 'm1',
        },
        { title: 'Task 2', why: 'Reason 2', threadId: 'thread-1', createdBy: 'user', ownerCatId: 'opus' },
      ],
    );
  });
});
