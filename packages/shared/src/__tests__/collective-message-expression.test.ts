import { expect, it } from 'vitest';
import { collectiveComposerDraftSchema, collectiveHumanMessageRequestSchema } from '../index.js';

it('keeps an interrupted recording and editable transcription in the private draft without publishing that private state', () => {
  const voiceDraft = { captureId: 'voice-capture-001', state: 'ready', transcript: '这段还没发送。', applied: true };
  const content = { body: '这段还没发送。', recipient: { kind: 'channel' }, recipientLabel: '', voiceDraft };
  expect(collectiveComposerDraftSchema.parse(content)).toEqual(content);
  expect(collectiveHumanMessageRequestSchema.safeParse({ ...request, voiceDraft }).success).toBe(false);
});

const quote = {
  v: 1 as const,
  id: 'ctx-channel-quote',
  kind: 'quote' as const,
  text: '保留这一段。',
  source: {
    kind: 'collective_message' as const,
    serviceInstanceId: 'svc_service01',
    collectiveId: 'col_collective01',
    channelId: 'general',
    eventId: 'evt_message01',
  },
};
const request = {
  serviceInstanceId: 'svc_service01',
  collectiveId: 'col_collective01',
  clientEventId: 'quote-send',
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: '',
  contextAttachments: [quote],
};

it('sends a sourced quote without forcing unrelated body text', () => {
  expect(collectiveHumanMessageRequestSchema.parse(request)).toEqual(request);
});

it('keeps Channel quotes bounded, distinct and independent of private Thread authority', () => {
  expect(
    collectiveHumanMessageRequestSchema.safeParse({ ...request, contextAttachments: [quote, quote] }).success,
  ).toBe(false);
  expect(
    collectiveHumanMessageRequestSchema.safeParse({
      ...request,
      contextAttachments: [
        { ...quote, source: { kind: 'message', threadId: 'private-thread', messageId: 'private-message' } },
      ],
    }).success,
  ).toBe(false);
  expect(
    collectiveHumanMessageRequestSchema.safeParse({
      ...request,
      contextAttachments: [{ ...quote, text: 'a'.repeat(20_001) }],
    }).success,
  ).toBe(false);
});
