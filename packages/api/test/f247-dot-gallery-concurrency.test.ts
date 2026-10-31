import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import sharp from 'sharp';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore, dotEventId } from '../src/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotImageService } from '../src/domains/cats/services/cloud-bridge/dot/DotImageService.js';
import { DotReturnService } from '../src/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import {
  type IMessageStore,
  MessageStore,
  type StoredMessage,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

test('different original publication keys retain both galleries across a Redis-style metadata read/write race', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-gallery-'));
  try {
    const messages = new MessageStore(),
      threads = new ThreadStore();
    const connection = new DotConnectionService({
      keys: new AgentKeyRegistry(),
      store: new DotConnectionStore(join(directory, 'connection.json')),
      authority: async () => ({ ownerUserId: 'owner', pluginInstanceId: 'dot-instance' }),
      ensureIdentity: async () => {},
    });
    const setup = await connection.begin('owner');
    const state = await connection.current();
    assert.ok(state);
    const thread = threads.create('owner', 'two original views');
    const source = messages.append({
      userId: 'owner',
      catId: null,
      threadId: thread.id,
      content: 'draw two views',
      mentions: [],
      timestamp: Date.now(),
    });
    const dispatches = new DotDispatchStore(join(directory, 'events'));
    const eventId = dotEventId(state.attemptId, thread.id, source.id, 'gallery-child');
    await dispatches.update(eventId, async () => ({
      record: {
        eventId,
        ownerUserId: 'owner',
        threadId: thread.id,
        sourceMessageId: source.id,
        dispatchInvocationId: 'gallery-child',
        attemptId: state.attemptId,
        agentKeyId: state.agentKeyId,
        occurredAt: Date.now(),
        webhookAcknowledgedAt: Date.now(),
        sourceReadAt: null,
        replyMessageId: null,
        imagePublicationIds: [],
        connectionTest: false,
      },
      result: undefined,
    }));
    const returns = new DotReturnService({
      connection,
      dispatches,
      messages,
      threads,
      postReply: async ({ threadId, sourceMessageId, content }) => ({
        messageId: messages.append({
          userId: 'owner',
          catId: createCatId('gpt-dot'),
          threadId,
          replyTo: sourceMessageId,
          content,
          mentions: [],
          timestamp: Date.now(),
        }).id,
      }),
    });
    await returns.read(setup.credentialSecret, eventId);
    const extras = new Map<string, StoredMessage['extra']>();
    const media: Pick<IMessageStore, 'getById' | 'augmentStreamMetadata'> = {
      getById: (id) => {
        const value = messages.getById(id);
        return value ? { ...value, extra: extras.get(id) ?? value.extra } : null;
      },
      augmentStreamMetadata: async (id, patch) => {
        const before = await media.getById(id);
        if (!before) return null;
        // Production Redis reads `extra`, merges in-process, then writes the complete value.
        const merged = {
          ...before.extra,
          rich: {
            v: 1 as const,
            blocks: Array.from(
              new Map(
                [...(before.extra?.rich?.blocks ?? []), ...(patch.extra?.rich?.blocks ?? [])].map((block) => [
                  block.id,
                  block,
                ]),
              ).values(),
            ),
          },
        };
        await new Promise((resolve) => setTimeout(resolve, 40));
        extras.set(id, merged);
        return media.getById(id);
      },
    };
    const imageOptions = {
      directory: join(directory, 'images'),
      returns,
      connection,
      dispatches,
      messages: media,
      threads,
      emit: () => {},
    };
    const images = new DotImageService(imageOptions);
    for (let invalid = 0; invalid < 9; invalid += 1) {
      await assert.rejects(
        images.publish(setup.credentialSecret, {
          event_id: eventId,
          publication_key: `invalid-${invalid}`,
          png_base64: '!bad!',
        }),
        /invalid_base64/,
      );
    }
    const bytes = await sharp({ create: { width: 12, height: 13, channels: 4, background: '#D4835A' } })
      .png()
      .toBuffer();
    const published = await Promise.all(
      ['front', 'side'].map((key) =>
        images.publish(setup.credentialSecret, {
          event_id: eventId,
          publication_key: key,
          png_base64: bytes.toString('base64'),
        }),
      ),
    );
    const [front, side] = published;
    assert.ok(front && side);
    assert.equal(front.messageId, side.messageId);
    const blocks = (await media.getById(front.messageId))?.extra?.rich?.blocks ?? [];
    assert.equal(blocks.length, 2);
    assert.deepEqual(new Set(blocks.map((block) => block.id)), new Set(published.map((item) => item.publicationId)));
    for (const publication of published)
      assert.equal((await images.read(publication.publicationId, 'owner')).bytes.equals(bytes), true);
    for (let view = 3; view <= 8; view += 1) {
      await images.publish(setup.credentialSecret, {
        event_id: eventId,
        publication_key: `view-${view}`,
        png_base64: bytes.toString('base64'),
      });
    }
    const resumed = new DotImageService({
      ...imageOptions,
      dispatches: new DotDispatchStore(join(directory, 'events')),
    });
    await assert.rejects(
      resumed.publish(setup.credentialSecret, {
        event_id: eventId,
        publication_key: 'view-9',
        png_base64: bytes.toString('base64'),
      }),
      /dot_image_publication_limit/,
    );
    await assert.rejects(
      resumed.publish(setup.credentialSecret, {
        event_id: eventId,
        publication_key: 'invalid-view-9',
        png_base64: 'not base64',
      }),
      /dot_image_publication_limit/,
    );
    const retry = await resumed.publish(setup.credentialSecret, {
      event_id: eventId,
      publication_key: 'front',
      png_base64: bytes.toString('base64'),
    });
    assert.equal(retry.publicationId, front.publicationId);
    assert.equal((await media.getById(front.messageId))?.extra?.rich?.blocks?.length, 8);
    assert.equal((await readdir(join(directory, 'images', 'files'))).length, 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
