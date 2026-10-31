import { describe, expect, it } from 'vitest';
import { buildNewConversationCreateBody } from '../new-conversation-create-request';

const BASE_INTENT = {
  v: 1 as const,
  createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
  messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
  projectPath: '/work/cafe',
  preferredCats: ['codex-sol'],
  creationStarted: false,
};

describe('F322 new-conversation create request', () => {
  it('sends the chosen name and pin through the canonical thread creation request', () => {
    expect(
      buildNewConversationCreateBody({
        ...BASE_INTENT,
        title: '  Quarterly research sprint  ',
        pinned: true,
      }),
    ).toEqual({
      idempotencyKey: BASE_INTENT.createIdempotencyKey,
      projectPath: '/work/cafe',
      preferredCats: ['codex-sol'],
      title: 'Quarterly research sprint',
      pinned: true,
    });
  });

  it('keeps the existing auto-title and unpinned path when both options are left empty', () => {
    expect(
      buildNewConversationCreateBody({
        ...BASE_INTENT,
        title: '   ',
        pinned: false,
      }),
    ).toEqual({
      idempotencyKey: BASE_INTENT.createIdempotencyKey,
      projectPath: '/work/cafe',
      preferredCats: ['codex-sol'],
    });
  });
});
