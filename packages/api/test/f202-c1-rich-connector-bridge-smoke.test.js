import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';

import { projectEnvelope } from '../dist/domains/messaging/envelope.js';

const execFile = promisify(execFileCallback);
const approvedWecomArchiveSha256 = '16792a18bb776f2bc53fba24f8d58bc3090f8ae14dc9755e058d7b9ac09b8608';

test(
  'an approved connector archive bridge preserves Host rich blocks without claiming adapter delivery',
  { skip: !process.env.F202_W25A_WECOM_ARCHIVE },
  async () => {
    const archive = process.env.F202_W25A_WECOM_ARCHIVE;
    const digest = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    assert.equal(digest, approvedWecomArchiveSha256, 'the bridge gate must use the approved archive');

    const root = await mkdtemp(join(tmpdir(), 'f202-w25a-connector-'));
    try {
      await execFile('tar', ['-xzf', archive, '-C', root]);
      const packageRoot = join(root, 'package');
      const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
      const { createWeComAgentPluginModule } = await import(
        pathToFileURL(join(packageRoot, manifest.runtime.entrypoint)).href
      );
      const subscribed = [];
      const formattedReplies = [];
      const module = createWeComAgentPluginModule(() => ({
        start: async () => undefined,
        stop: async () => undefined,
        outbound: {
          sendFormattedReply: async (...args) => formattedReplies.push(args),
          sendMedia: async () => undefined,
          sendReply: async () => undefined,
        },
      }));
      const host = {
        config: { get: async (key) => ({ corpId: 'corp', agentId: 'agent' })[key] },
        secrets: { get: async () => 'fixture-secret' },
        threads: { listBindings: async () => [{ threadId: 'thread-1', key: 'external-1' }] },
        messaging: {
          subscribe: async (input) => {
            subscribed.push(input);
            return { subscriptionId: 'sub-1' };
          },
          unsubscribe: async () => undefined,
        },
        log: () => undefined,
      };
      const active = await module.create(manifest).start(host);
      assert.deepEqual(
        subscribed.map(({ threadId }) => threadId),
        ['thread-1'],
      );

      const card = { id: 'card-1', kind: 'card', v: 1, title: 'Approval', bodyMarkdown: 'Review the proposal' };
      const checklist = { id: 'checklist-1', kind: 'checklist', v: 1, title: 'Steps', items: [] };
      const stored = {
        id: 'message-1',
        threadId: 'thread-1',
        userId: 'owner-1',
        catId: 'opus',
        content: 'rich reply',
        mentions: [],
        timestamp: 1_800_000_000_000,
        extra: { rich: { v: 1, blocks: [card, checklist] } },
      };
      const envelope = projectEnvelope(stored);
      const originalClone = globalThis.structuredClone;
      const bridgeDeliveries = [];
      globalThis.structuredClone = (value, options) => {
        if (value?.externalConversationId === 'external-1' && Array.isArray(value.richBlocks)) {
          bridgeDeliveries.push(originalClone(value));
        }
        return originalClone(value, options);
      };
      try {
        await active.actions['wecom-agent.outbound']({
          deliveryId: 'delivery-1',
          threadId: 'thread-1',
          envelope,
        });
      } finally {
        globalThis.structuredClone = originalClone;
        await active.stop();
      }
      assert.equal(bridgeDeliveries.length, 1);
      assert.deepEqual(
        bridgeDeliveries[0].richBlocks,
        stored.extra.rich.blocks,
        'the approved package bridge must pass each stored block without wrapping or renaming',
      );
      assert.equal(formattedReplies.length, 1);
      // This approved package action does not consume richBlocks after the bridge. W2-5p owns adapter parity.
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
