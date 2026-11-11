import { expect, it, vi } from 'vitest';
import { scheduleProposal } from '@/components/rich/__tests__/schedule-approval.fixture';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { chatModels } from '../chat-models';
import { fixtureData, fixtureUi } from './chat-fixture';

it('includes dispatched history targets and their read/uncertain receipts beside still-queued targets', () => {
  const data = fixtureData();
  const dispatch = {
    targetId: 'codex',
    phase: 'dispatched' as const,
    dispatchedAt: 2,
    statusMessageId: 'reply-1',
    appendAcceptance: 'written' as const,
    inputRead: { status: 'read' as const, at: 3 },
  };
  const failure = {
    targetId: 'codex',
    invocationId: 'turn',
    responseMessageId: 'reply-1',
    reason: 'exception' as const,
    acceptance: 'unknown' as const,
    at: 4,
  };
  data.messages[0].lifecycle = {
    kind: 'input',
    orderKey: '1:user',
    dispatchRefs: [dispatch],
    appendFailures: [failure],
  };
  data.messages[1].lifecycle = {
    kind: 'response',
    orderKey: '2:reply',
    invocationId: 'turn',
    targetId: 'codex',
    inputEntryIds: ['entry'],
    inputMessageIds: ['user-1'],
    status: 'processing',
    startedAt: 2,
  };
  data.queue = [
    {
      id: 'queue',
      threadId: data.threadId,
      messageId: 'user-1',
      content: 'Queued',
      targetCats: ['other'],
      status: 'queued',
    } as QueueEntry,
  ];
  expect(chatModels(data, fixtureUi()).chatComposer.queue!.items[0].delivery).toEqual([
    { id: 'other', queued: true, dispatch: null, failure: undefined },
    { id: 'codex', queued: false, dispatch, failure },
  ]);
  data.messages[1].lifecycle = { ...data.messages[1].lifecycle, inputMessageIds: ['different-source'] };
  expect(chatModels(data, fixtureUi()).chatComposer.queue!.items[0].delivery[1].dispatch).toBeNull();
});

it('projects schedule update parameters and requires the matching durable checkpoint before showing applied', () => {
  const data = fixtureData(),
    proposal = scheduleProposal('approved');
  if (proposal.mutation.kind !== 'create') throw new Error('create fixture');
  const task = { ...proposal.mutation.task, params: { text: 'before', unchanged: true } };
  proposal.mutation = {
    kind: 'update',
    taskId: task.id,
    taskSnapshot: task,
    expectedFingerprint: 'original',
    params: { text: 'after', unchanged: true },
  };
  delete proposal.effectCheckpoint;
  data.schedules = {
    schedule: {
      mid: 'reply-1',
      blockId: 'schedule-card',
      proposal,
      current: true,
      blocked: false,
      drifted: false,
      error: null,
      templates: [{ templateId: task.templateId, paramSchema: { text: { description: 'Owner description' } } }],
      decide: vi.fn(),
    },
  };
  const card = () => chatModels(data, fixtureUi()).chatStream.items.find((item) => item.mid === 'reply-1')!.card;
  expect(card()).toMatchObject({
    schedule: proposal,
    task,
    changes: [{ key: 'text', description: 'Owner description', before: 'before', after: 'after' }],
    effect: false,
  });
  proposal.effectCheckpoint = {
    kind: 'update',
    taskId: task.id,
    expectedFingerprint: 'original',
    resultingFingerprint: 'updated',
    appliedAt: 5,
  };
  expect(card()).toMatchObject({ effect: true });
  proposal.effectCheckpoint.expectedFingerprint = 'another-write';
  expect(card()).toMatchObject({ effect: false });
});

it('passes watcher provenance unchanged and leaves the failure text to the terminal message itself', () => {
  const data = fixtureData();
  const watcher = {
    kind: 'nudge' as const,
    sourceInvocationId: 'source-turn',
    sourceMessageId: 'source-message',
    watcherInvocationId: 'watcher-turn',
  };
  data.messages[1] = { ...data.messages[1], metadata: { provider: 'pi', model: 'owner-model' }, extra: { watcher } };
  const node = chatModels(data, fixtureUi()).chatStream.items[1];
  expect(node).toMatchObject({ watcher });
  expect(node).not.toHaveProperty('cliDiagnostics');
});

it('keeps context briefings out of the conversation: the terminal message carries the outcome', () => {
  const data = fixtureData();
  data.messages.push({
    id: 'briefing',
    type: 'system',
    content: '真相源: 未定位',
    origin: 'briefing',
    timestamp: data.messages[1]!.timestamp + 1,
    extra: { systemKind: 'context_briefing' },
  } as ChatMessage);
  expect(chatModels(data, fixtureUi()).chatStream.items.some((item) => item.mid === 'briefing')).toBe(false);
});
