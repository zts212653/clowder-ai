import type { ContextAttachment } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { addWorkspaceFileQuoteToChat, workspaceFileQuoteAttachment } from '../workspace-file-quote';

const HEX = 'a1'.repeat(32);
const SELECTION = { text: '暮色里的灯塔', comment: '保留', path: 'docs/a.md', worktreeId: 'wt-1' } as const;

function sourceOf(attachment: ContextAttachment) {
  if (attachment.kind !== 'quote' || attachment.source.kind !== 'workspace_file') throw new Error('not a file quote');
  return attachment.source;
}

describe('workspace file quote', () => {
  it('names the exact F063 revision of the file the selection was made in, in the owner’s own form', () => {
    const source = sourceOf(workspaceFileQuoteAttachment({ ...SELECTION, revision: `sha256:${HEX}` }));
    expect(source.revision).toBe(`sha256:${HEX}`);
    expect(source.path).toBe('docs/a.md');
    expect(source.worktreeId).toBe('wt-1');
  });

  it('takes the bare digest a file API answers with and says it in that same form', () => {
    expect(sourceOf(workspaceFileQuoteAttachment({ ...SELECTION, revision: HEX })).revision).toBe(`sha256:${HEX}`);
  });

  it('claims no version it cannot back: unknown or not a digest leaves the reference unversioned', () => {
    for (const revision of [null, '', 'sha-1', `sha256:${HEX.slice(1)}`, HEX.toUpperCase(), `sha512:${HEX}`]) {
      const source = sourceOf(workspaceFileQuoteAttachment({ ...SELECTION, revision }));
      expect('revision' in source, `revision ${JSON.stringify(revision)}`).toBe(false);
    }
  });

  describe('adding to the chat', () => {
    beforeEach(() => {
      useChatStore.setState({ pendingChatInsert: null });
    });

    it('puts the versioned reference in that conversation’s input, and nothing else', () => {
      addWorkspaceFileQuoteToChat('thread-1', { ...SELECTION, revision: HEX });
      const insert = useChatStore.getState().pendingChatInsert;
      expect(insert?.threadId).toBe('thread-1');
      expect(insert?.text).toBe('');
      expect(insert?.contextAttachments).toHaveLength(1);
      const [attachment] = insert?.contextAttachments ?? [];
      expect(sourceOf(attachment as ContextAttachment).revision).toBe(`sha256:${HEX}`);
    });

    it('keeps a place still waiting for the input when another place is added to the same conversation', () => {
      // The input takes a queued place only when it is there to take it (a chat folded away for reading the file
      // does not): a second place must not replace the first.
      addWorkspaceFileQuoteToChat('thread-1', { ...SELECTION, text: '第一处', revision: HEX });
      addWorkspaceFileQuoteToChat('thread-1', { ...SELECTION, text: '第二处', revision: HEX });
      const queued = useChatStore.getState().pendingChatInsert?.contextAttachments ?? [];
      expect(queued.map((attachment) => (attachment.kind === 'quote' ? attachment.text : null))).toEqual([
        '第一处',
        '第二处',
      ]);
      expect(new Set(queued.map((attachment) => attachment.id)).size).toBe(2);
    });

    it('does not carry a place waiting for one conversation into another', () => {
      addWorkspaceFileQuoteToChat('thread-1', { ...SELECTION, text: '第一处', revision: HEX });
      addWorkspaceFileQuoteToChat('thread-2', { ...SELECTION, text: '第二处', revision: HEX });
      const insert = useChatStore.getState().pendingChatInsert;
      expect(insert?.threadId).toBe('thread-2');
      expect(insert?.contextAttachments).toHaveLength(1);
    });
  });
});
