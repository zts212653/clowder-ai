import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { textRequestSubjectOf } from '../text-message-request';

const REVISION = `sha256:${'a'.repeat(64)}` as const;
const OTHER = `sha256:${'b'.repeat(64)}` as const;

const quote = (
  id: string,
  source: Partial<Extract<ContextAttachment, { kind: 'quote' }>['source']> & { kind?: string } = {},
): ContextAttachment =>
  ({
    v: 1,
    id,
    kind: 'quote',
    text: `words ${id}`,
    selectionStart: 0,
    selectionEnd: 5,
    source: {
      kind: 'workspace_file',
      path: 'docs/plans/launch-plan.md',
      worktreeId: 'w1',
      revision: REVISION,
      ...source,
    },
  }) as ContextAttachment;
const block = (attachment: ContextAttachment): MessageContent => ({ type: 'context_attachment', attachment });

describe('textRequestSubjectOf', () => {
  it('names the file and counts the places of a message that quotes one file at one version', () => {
    expect(textRequestSubjectOf([{ type: 'text', text: '改一下' }, block(quote('1')), block(quote('2'))])).toEqual({
      title: 'launch-plan.md',
      placeCount: 2,
    });
  });

  it('is nothing for a message with no quote of a file', () => {
    expect(textRequestSubjectOf(undefined)).toBeNull();
    expect(textRequestSubjectOf([{ type: 'text', text: '你好' }])).toBeNull();
    expect(textRequestSubjectOf([block(quote('1', { kind: 'message', threadId: 't', messageId: 'm' }))])).toBeNull();
  });

  it('is nothing for an old quote that names no version: the owner can never take it over', () => {
    expect(textRequestSubjectOf([block(quote('1', { revision: undefined }))])).toBeNull();
    expect(textRequestSubjectOf([block(quote('1')), block(quote('2', { revision: undefined }))])).toBeNull();
  });

  it('is nothing for a quote that names no worktree', () => {
    expect(textRequestSubjectOf([block(quote('1', { worktreeId: undefined }))])).toBeNull();
  });

  it('is nothing when the places are of different files, worktrees or versions: the owner refuses those', () => {
    expect(textRequestSubjectOf([block(quote('1')), block(quote('2', { path: 'docs/other.md' }))])).toBeNull();
    expect(textRequestSubjectOf([block(quote('1')), block(quote('2', { worktreeId: 'w2' }))])).toBeNull();
    expect(textRequestSubjectOf([block(quote('1')), block(quote('2', { revision: OTHER }))])).toBeNull();
  });

  it('is nothing for a message that also carries a picture: the picture path owns that message', () => {
    const media = {
      v: 1,
      id: 'm1',
      kind: 'media',
      title: 'x.png',
      mediaType: 'image/png',
    } as unknown as ContextAttachment;
    expect(textRequestSubjectOf([block(quote('1')), block(media)])).toBeNull();
  });

  it('counts only the places in the file; quotes of other things in the same message are not places', () => {
    expect(
      textRequestSubjectOf([
        block(quote('1')),
        block(quote('2', { kind: 'cli_output', threadId: 't', messageId: 'm' })),
      ]),
    ).toEqual({ title: 'launch-plan.md', placeCount: 1 });
  });
});
