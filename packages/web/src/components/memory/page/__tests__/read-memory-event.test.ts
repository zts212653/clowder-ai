import { afterEach, expect, it, vi } from 'vitest';
import { readEvent } from '../read-memory-event';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
const revision = `sha256:${'a'.repeat(64)}`;
const event = {
  eventId: 'event-a',
  ownerUserId: 'owner',
  type: '数学之美',
  trigger: 'human_brake',
  cat: 'codex61-sol',
  threadId: 'thread-a',
  messageId: 'message-a',
  timestamp: 100,
  summary: '先看清目标。',
  cognitiveTransition: null,
  relatedHarness: null,
  confidence: 'high',
  revision,
  status: 'active',
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
afterEach(() => vi.resetAllMocks());

it('rejects a complete response for a different event before exposing actions', async () => {
  apiFetch.mockResolvedValue(response({ ...event, eventId: 'another-event' }));
  await expect(readEvent('event-a', new AbortController().signal)).rejects.toThrow();
});

it('pins every oversized slice to the read revision and rejects same-length replacement', async () => {
  const serialized = JSON.stringify(event);
  apiFetch.mockResolvedValueOnce(
    response({ oversized: true, eventId: 'event-a', eventChars: serialized.length, revision }),
  );
  apiFetch.mockResolvedValueOnce(
    response({
      revision: `sha256:${'b'.repeat(64)}`,
      charOffset: 0,
      totalChars: serialized.length,
      eventSlice: serialized,
    }),
  );
  await expect(readEvent('event-a', new AbortController().signal)).rejects.toThrow();
  expect(apiFetch.mock.calls[1][0]).toContain(`charOffset=0&revision=${encodeURIComponent(revision)}`);
});

it('stops drilling when the detail is closed while a response body is pending', async () => {
  const controller = new AbortController();
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => {
      controller.abort();
      return { oversized: true, eventId: 'event-a', eventChars: 10, revision };
    },
  });
  await expect(readEvent('event-a', controller.signal)).rejects.toThrow();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('assembles only contiguous slices from one revision into the complete event', async () => {
  const serialized = JSON.stringify(event);
  const split = 100;
  apiFetch.mockResolvedValueOnce(
    response({ oversized: true, eventId: 'event-a', eventChars: serialized.length, revision }),
  );
  apiFetch.mockResolvedValueOnce(
    response({ revision, charOffset: 0, totalChars: serialized.length, eventSlice: serialized.slice(0, split) }),
  );
  apiFetch.mockResolvedValueOnce(
    response({ revision, charOffset: split, totalChars: serialized.length, eventSlice: serialized.slice(split) }),
  );
  await expect(readEvent('event-a', new AbortController().signal)).resolves.toEqual(event);
});

it('retains validated correction suggestions from the oversized envelope without mixing them into canonical slices', async () => {
  const serialized = JSON.stringify(event);
  const proposal = {
    proposalId: 'proposal-a',
    status: 'pending',
    expectedRevision: revision,
    reason: 'outdated',
    suggestedPatch: { summary: '新的解释' },
    sourceCatId: 'codex61-sol',
    sourceThreadId: 'thread-a',
    source: { threadId: 'thread-a', messageId: 'message-a' },
    createdAt: 100,
  };
  apiFetch.mockResolvedValueOnce(
    response({
      oversized: true,
      eventId: 'event-a',
      eventChars: serialized.length,
      revision,
      pendingCorrectionCount: 1,
      correctionProposals: [proposal],
    }),
  );
  apiFetch.mockResolvedValueOnce(
    response({
      revision,
      charOffset: 0,
      totalChars: serialized.length,
      eventSlice: serialized,
    }),
  );
  await expect(readEvent('event-a', new AbortController().signal)).resolves.toEqual({
    ...event,
    pendingCorrectionCount: 1,
    correctionProposals: [proposal],
  });
});

it('rejects malformed suggestion metadata before exposing approval controls', async () => {
  apiFetch.mockResolvedValue(response({ ...event, pendingCorrectionCount: -1, correctionProposals: [{}] }));
  await expect(readEvent('event-a', new AbortController().signal)).rejects.toThrow();
});
