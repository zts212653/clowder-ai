import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { companionAuthorName } from '../src/domains/concierge/live/host/companion-author-name.js';
import { CompanionDeskOwner } from '../src/domains/concierge/live/host/companion-desk-owner.js';
import { createDeskPipe } from '../src/domains/plugin/desktop-window-runtime/desk-pipe.js';
import { createSuggestionIntegration } from '../src/domains/suggestions/composition.js';

interface NativeDeskPipe {
  next(returning: boolean): Promise<unknown>;
  settle(input: unknown): Promise<unknown>;
  accept(frame: unknown): void;
  close(): void;
}
const require = createRequire(import.meta.url);
const { createDeskOwnerPipe } = require('../../../desktop/plugin-window/desk-pipe.cjs') as {
  createDeskOwnerPipe(write: (frame: string, callback?: (error?: Error) => void) => void): NativeDeskPipe;
};

const USER = 'owner-operator';
const WORK = { contentRef: 'work:sheet', ownerRevision: 1 };
const CARD = {
  id: 'work-reference-abc',
  kind: 'card',
  v: 1,
  title: '六猫岛 · 单采肖像参考',
  bodyMarkdown: '',
  meta: { kind: 'work_reference', reference: WORK },
};

function setup() {
  const messages = new Map<string, unknown>([
    ['msg-sol', { id: 'msg-sol', userId: USER, threadId: 'thread_video', extra: { rich: { v: 1, blocks: [CARD] } } }],
  ]);
  const suggestions = createSuggestionIntegration({
    messageStore: { getById: (id) => (messages.get(id) as never) ?? null },
    threadTitle: async () => '「视频」自媒体视频运营',
  });
  const opened: unknown[] = [];
  let current = true;
  const owner = new CompanionDeskOwner({
    desk: suggestions.desk,
    ownerUserId: USER,
    assertCurrent: async () => {
      if (!current) throw new Error('lease lost');
    },
    messages: { getById: (id: string) => messages.get(id) ?? null },
    openCard: async (destination) => {
      opened.push(destination);
      return true;
    },
  });
  let native!: NativeDeskPipe;
  const host = createDeskPipe(owner, (line) => native.accept(JSON.parse(line)));
  native = createDeskOwnerPipe((frame, callback) => {
    host.accept(JSON.parse(frame));
    callback?.();
  });
  return { suggestions, owner, native, host, opened, revoke: () => (current = false) };
}

test('F335 desk pipe: the kernel asks, the desk answers with names; 打开 brings Clowder AI to the card', async () => {
  const { suggestions, native, opened } = setup();
  await suggestions.desk.bring(
    { userId: USER, threadId: 'thread_video', catId: 'codex61-sol', invocationId: 'i', byline: 'watcher' },
    { messageId: 'msg-sol', sentence: '鲸鲸那三格，照他的头像画就行。', work: WORK },
  );
  const delivery = (await native.next(false)) as { mode: string; items: Array<Record<string, unknown>> };
  assert.equal(delivery.mode, 'single');
  assert.equal(delivery.items[0]?.catName, companionAuthorName('codex61-sol'));
  const item = delivery.items[0] as { ref: string; revision: number };
  const settled = (await native.settle({ action: 'open', items: [{ ref: item.ref, revision: item.revision }] })) as {
    items: Array<{ outcome: string }>;
    opened?: boolean;
  };
  assert.equal(settled.items[0]?.outcome, 'settled');
  assert.equal(settled.opened, true);
  assert.deepEqual(opened, [{ threadId: 'thread_video', messageId: 'msg-sol', blockId: 'work-reference-abc' }]);
  assert.equal(await native.next(true), null);
});

test('F335 desk pipe: a revoked lease answers nothing, and malformed commands never reach the desk', async () => {
  const { native, host, revoke } = setup();
  const id = '00000000-0000-4000-8000-000000000000';
  const settle = { kind: 'settle', settle: { action: 'open', items: [] } };
  assert.equal(
    host.accept({ v: 1, type: 'desk', id, command: settle }),
    false,
    'a settle with no lines is not a desk frame',
  );
  assert.equal(
    host.accept({ v: 1, type: 'desk', id: 'not-a-uuid', command: { kind: 'next', returning: false } }),
    false,
  );
  revoke();
  await assert.rejects(() => native.next(false), /unavailable/);
});
