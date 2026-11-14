import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  DotLegacyMigrationCoordinator,
  mediaImportKey,
} from '../src/domains/plugin/migration/dot-legacy-migration-coordinator.js';
import type {
  LegacyDotConnectionState,
  LegacyDotDispatchRecord,
} from '../src/domains/plugin/migration/dot-legacy-schemas.js';
import type { LegacyDotImageMetadata } from '../src/domains/plugin/migration/dot-legacy-source-reader.js';

const now = 1000;
const secret = 'a'.repeat(64);
const salt = 'salt';
const sourceInstanceId = 'legacy-instance';
const targetInstanceId = 'pi_dot_reviewed';
const packageDigest = `sha512-${Buffer.alloc(64, 4).toString('base64')}`;

function connection(): LegacyDotConnectionState {
  return {
    v: 1,
    revision: 1,
    ownerUserId: 'owner-1',
    pluginInstanceId: sourceInstanceId,
    agentKeyId: 'ak_legacy',
    credentialSecret: secret,
    attemptId: 'attempt-1',
    pairingCode: 'b'.repeat(32),
    pairingExpiresAt: 2000,
    pairedAt: 1,
    pairedCallbackUrl: 'https://example.com/dot',
    subscription: null,
    lastSourceReadAt: null,
    lastReplyAt: null,
    lastImageAt: null,
    revokedAt: null,
    testEventIds: [],
  };
}

function dispatch(index: number): LegacyDotDispatchRecord {
  return {
    eventId: `dot_evt_${index.toString(16).padStart(64, '0')}`,
    ownerUserId: 'owner-1',
    threadId: `thread-${index}`,
    sourceMessageId: `message-${index}`,
    dispatchInvocationId: `invocation-${index}`,
    attemptId: 'attempt-1',
    agentKeyId: 'ak_legacy',
    occurredAt: index + 1,
    webhookAcknowledgedAt: null,
    sourceReadAt: null,
    replyMessageId: null,
    imagePublicationIds: [],
    connectionTest: false,
  };
}

test('imports connection, bounded dispatch batches, then individual images and durable media', async () => {
  const dispatches = Array.from({ length: 101 }, (_, index) => dispatch(index));
  const bytes = [Buffer.from('image-one'), Buffer.from('image-two')];
  const images: LegacyDotImageMetadata[] = bytes.map((value, index) => {
    const record = dispatches[index];
    assert.ok(record);
    return {
      id: `dot_img_${(index + 1).toString(16).padStart(64, '0')}`,
      ownerUserId: 'owner-1',
      threadId: record.threadId,
      eventId: record.eventId,
      publicationKey: `publication-${index}`,
      sha256: createHash('sha256').update(value).digest('hex'),
      byteSize: value.byteLength,
      width: 1,
      height: 1,
      messageId: null,
      alt: `image-${index}`,
    };
  });
  const calls: Array<Record<string, unknown>> = [];
  const registrations: Array<Record<string, unknown>> = [];
  const adopted: Array<Record<string, unknown>> = [];
  const sharedAdopted: Array<Record<string, unknown>> = [];
  const completionOrder: string[] = [];
  let saved: unknown;
  const coordinator = new DotLegacyMigrationCoordinator({
    source: {
      connection: async () => connection(),
      dispatches: async () => dispatches,
      imageMetadata: async () => images,
      imageBytes: async (id) => {
        const value = bytes[images.findIndex((image) => image.id === id)];
        assert.ok(value);
        return value;
      },
    },
    keys: {
      get: async () => ({
        agentKeyId: 'ak_legacy',
        catId: createCatId('gpt-dot'),
        userId: 'owner-1',
        secretHash: createHash('sha256')
          .update(secret + salt)
          .digest('hex'),
        salt,
        scope: 'user-bound',
        issuedAt: 1,
        expiresAt: null,
      }),
    },
    invoker: {
      async invoke(input) {
        const batch = input.payload as {
          connection?: unknown;
          dispatches: unknown[];
          images: unknown[];
          ownerUserId: string;
          sourceInstanceId: string;
        };
        calls.push({
          connection: batch.connection ? 1 : 0,
          dispatches: batch.dispatches.length,
          images: batch.images.length,
        });
        return {
          version: 1,
          batchDigest: createHash('sha256').update(JSON.stringify(batch)).digest('hex'),
          ownerUserId: batch.ownerUserId,
          sourceInstanceId: batch.sourceInstanceId,
          pluginInstanceId: input.expectedPluginInstanceId,
          connection: batch.connection ? 1 : 0,
          dispatches: batch.dispatches.length,
          images: batch.images.length,
          inserted: 1,
          alreadyPresent: 0,
          sourceDeleted: false,
          importedAt: now,
        };
      },
    },
    media: {
      async register(value, meta) {
        registrations.push({ value: Buffer.from(value as Uint8Array).toString(), ...meta });
        return `hmr_${String(registrations.length).padStart(32, '0')}`;
      },
    },
    audit: {
      save: async (audit) => {
        completionOrder.push('audit');
        saved = audit;
      },
    },
    externalAccess: {
      revokeLegacy: async () => {},
      adopt: async (instanceId, token) => {
        adopted.push({ instanceId, token });
      },
    },
    sharedExtension: {
      adoptVerifiedLegacy: async (input) => {
        completionOrder.push('shared');
        sharedAdopted.push({ ...input });
      },
    },
    now: () => now,
  });

  const result = await coordinator.migrate({
    ownerUserId: 'owner-1',
    expectedPluginInstanceId: targetInstanceId,
    expectedPackageDigest: packageDigest,
  });

  assert.deepEqual(calls, [
    { connection: 1, dispatches: 0, images: 0 },
    { connection: 0, dispatches: 100, images: 0 },
    { connection: 0, dispatches: 1, images: 0 },
    { connection: 0, dispatches: 0, images: 1 },
    { connection: 0, dispatches: 0, images: 1 },
  ]);
  assert.deepEqual(
    registrations.map(({ value, ownerInstanceId, mimeType, importKey }) => ({
      value,
      ownerInstanceId,
      mimeType,
      importKey,
    })),
    images.map((image, index) => {
      const value = bytes[index];
      assert.ok(value);
      return {
        value: value.toString(),
        ownerInstanceId: targetInstanceId,
        mimeType: 'image/png',
        importKey: mediaImportKey(image),
      };
    }),
  );
  assert.equal(result.receipts.length, 5);
  assert.equal(result.authority.active, true);
  assert.deepEqual(adopted, [{ instanceId: targetInstanceId, token: secret }]);
  assert.deepEqual(sharedAdopted, []);
  assert.deepEqual(completionOrder, ['audit']);
  await coordinator.reconcileShared(result);
  assert.deepEqual(sharedAdopted, [
    {
      instanceId: targetInstanceId,
      expectedPackageDigest: packageDigest,
      ownerUserId: 'owner-1',
      evidenceRef: 'legacy-dot:legacy-instance:ak_legacy',
      assertLegacyAuthority: sharedAdopted[0]?.assertLegacyAuthority,
    },
  ]);
  assert.deepEqual(completionOrder, ['audit', 'shared']);
  assert.equal(result.sourceDeleted, false);
  assert.deepEqual(saved, result);
});

test('rejects a forged package receipt before Host media materialization', async () => {
  let registrations = 0;
  const imageBytes = Buffer.from('image');
  const record = dispatch(0);
  const image: LegacyDotImageMetadata = {
    id: `dot_img_${'1'.repeat(64)}`,
    ownerUserId: 'owner-1',
    threadId: record.threadId,
    eventId: record.eventId,
    publicationKey: 'publication',
    sha256: createHash('sha256').update(imageBytes).digest('hex'),
    byteSize: imageBytes.length,
    width: 1,
    height: 1,
    messageId: null,
    alt: 'image',
  };
  const coordinator = new DotLegacyMigrationCoordinator({
    source: {
      connection: async () => connection(),
      dispatches: async () => [record],
      imageMetadata: async () => [image],
      imageBytes: async () => imageBytes,
    },
    keys: { get: async () => null },
    invoker: {
      invoke: async () => ({
        version: 1,
        batchDigest: '0'.repeat(64),
        ownerUserId: 'owner-1',
        sourceInstanceId,
        pluginInstanceId: targetInstanceId,
        connection: 1,
        dispatches: 0,
        images: 0,
        inserted: 1,
        alreadyPresent: 0,
        sourceDeleted: false,
        importedAt: now,
      }),
    },
    media: {
      register: async () => {
        registrations += 1;
        return `hmr_${'a'.repeat(32)}`;
      },
    },
    audit: { save: async () => {} },
    now: () => now,
  });

  await assert.rejects(
    coordinator.migrate({
      ownerUserId: 'owner-1',
      expectedPluginInstanceId: targetInstanceId,
      expectedPackageDigest: packageDigest,
    }),
    /receipt_mismatch/,
  );
  assert.equal(registrations, 0);
});
