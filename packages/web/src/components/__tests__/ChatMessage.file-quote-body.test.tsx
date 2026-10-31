import type { ContextAttachment } from '@cat-cafe/shared';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

// This test concerns the spoken body and quotes. The separately tested execution record is outside that contract.
vi.mock('../reply-layers/ReplyLayers', () => ({ ReplyLayers: () => null }));

const attachment: ContextAttachment = {
  v: 1,
  id: 'file-quote',
  kind: 'quote',
  text: 'Original paragraph',
  source: { kind: 'workspace_file', path: 'guide.md', worktreeId: 'work', revision: `sha256:${'a'.repeat(64)}` },
};
let harness: ReplyLayersHarness | undefined;
beforeAll(installReplyLayersActEnvironment);
afterAll(uninstallReplyLayersActEnvironment);
afterEach(() => harness?.dispose());

it.each(['classic', 'v2'] as const)('keeps the cat callback body alongside its file quote in %s', (shell) => {
  harness = new ReplyLayersHarness();
  if (shell === 'v2') harness.enableV2();
  harness.render(
    streamReply({
      origin: 'callback',
      content: '这是我对该段原文的回答',
      toolEvents: [],
      contentBlocks: [{ type: 'context_attachment', attachment }],
    }),
  );
  expect(harness.container.textContent).toContain('这是我对该段原文的回答');
  expect(harness.q('context-attachment-file-quote')?.textContent).toContain('Original paragraph');
});

it('does not duplicate a body already carried by a text block', () => {
  harness = new ReplyLayersHarness();
  harness.enableV2();
  harness.render(
    streamReply({
      origin: 'callback',
      content: '这段正文只出现一次',
      toolEvents: [],
      contentBlocks: [
        { type: 'text', text: '这段正文只出现一次' },
        { type: 'context_attachment', attachment },
      ],
    }),
  );
  expect(harness.container.textContent?.match(/这段正文只出现一次/g)).toHaveLength(1);
});
