import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveMediaBinding } from '../src/domains/collaborative-content/collective-artifact/media-source.js';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.js';
import { createCollectiveArtifactOwnerProxy } from '../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { publishedCollectiveFixture } from './collective-published-media.fixture.js';

const instanceId = 'pi_collective';
const constraint = {
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  connectionId: 'connection',
  authorizedHumanId: 'remote-human',
};
const authority = { reauthorize: async () => constraint };
function ownerHttp<T>(
  run: () => Promise<T>,
  {
    operation = 'write',
    legacy = false,
    signal = new AbortController().signal,
    userId = 'operator',
  }: {
    operation?: 'read' | 'write';
    legacy?: boolean;
    signal?: AbortSignal;
    userId?: string;
  } = {},
) {
  return withPluginOwnerRequest(
    {
      pluginId: 'official.collective-connector',
      contributionId: 'retained-media',
      userId,
      operation,
      signal,
      ...(legacy
        ? {}
        : {
            requestIdentity: {
              requestId: 'req-1',
              transportRequestId: 'http-1',
              method: operation === 'write' ? 'POST' : 'GET',
              declaredPath: '/retained-media',
              path: '/retained-media',
              bodyDigest: 'sha256:body',
              queryDigest: 'sha256:query',
            },
          }),
    },
    () => withPluginOwnerWebhook('official.collective-connector', 'retained-media', instanceId, false, () => {}, run),
  );
}
async function fixture(t: Parameters<typeof publishedCollectiveFixture>[0]) {
  const f = await publishedCollectiveFixture(t);
  const proxy = createCollectiveArtifactOwnerProxy({
    owner: () => f.port,
    retainedMedia: () => f.port,
    pluginInstanceId: instanceId,
    assertCurrent: async () => {},
  });
  const input = { contentRef: f.asset.contentRef, ownerRevision: f.asset.ownerRevision, scope: f.scope };
  return { ...f, proxy, input };
}

test('owner HTTP lists existing retained media and shares only a minimal registration receipt', async (t) => {
  const f = await fixture(t);
  const page = await ownerHttp(() => f.proxy.media!.listRetained!({}, authority), { operation: 'read' });
  assert.ok(page.items.some((item) => item.contentRef === f.asset.contentRef));
  const receipt = await ownerHttp(() => f.proxy.media!.prepareShare!(f.input, authority));
  assert.deepEqual(Object.keys(receipt).sort(), [
    'blobDigest',
    'contentRef',
    'mediaType',
    'ownerReceiptRef',
    'ownerRevision',
  ]);
  assert.equal(receipt.contentRef, f.asset.contentRef);
  assert.equal(receipt.blobDigest, f.asset.blobDigest);
  assert.equal(JSON.stringify(receipt).includes('operator'), false);
});

test('background, legacy, wrong local user, read-only share and crossed remote scope are rejected', async (t) => {
  const f = await fixture(t);
  const read = () => f.proxy.media!.listRetained!({}, authority);
  const share = () => f.proxy.media!.prepareShare!(f.input, authority);
  await assert.rejects(read(), /owner HTTP request/);
  await assert.rejects(ownerHttp(read, { legacy: true }), /owner HTTP request/);
  await assert.rejects(ownerHttp(read, { userId: 'foreign-owner' }), /access_denied/);
  await assert.rejects(ownerHttp(share, { operation: 'read' }), /owner HTTP request/);
  await assert.rejects(
    ownerHttp(() =>
      f.proxy.media!.prepareShare!({ ...f.input, scope: { ...f.scope, collectiveId: 'foreign' } }, authority),
    ),
    /scope mismatch/,
  );
  await assert.rejects(
    ownerHttp(() => f.proxy.media!.listRetained!({ userId: 'forged' } as never, authority)),
    /Unrecognized key/,
  );
});

test('remote revocation during the retained read cannot bind the review ledger', async (t) => {
  const f = await fixture(t);
  const binding = collectiveMediaBinding(f.scope, f.asset.contentRef);
  let allowed = true;
  const original = f.media.read.bind(f.media);
  f.media.read = async (...args) => {
    const result = await original(...args);
    allowed = false;
    return result;
  };
  await assert.rejects(
    ownerHttp(() =>
      f.proxy.media!.prepareShare!(f.input, {
        reauthorize: async () => {
          if (!allowed) throw new Error('Remote permission revoked');
          return constraint;
        },
      }),
    ),
    /Remote permission revoked/,
  );
  assert.equal(f.reviews.getByContent('operator', binding.ledgerRef, binding.scope.scopeRef), null);
});

test('request abort during a local read denies the reply, and captured async contexts expire', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = f.port.listRetained.bind(f.port);
  f.port.listRetained = async (...args) => {
    const result = await original(...args);
    controller.abort();
    return result;
  };
  await assert.rejects(
    ownerHttp(() => f.proxy.media!.listRetained!({}, authority), { signal: controller.signal }),
    /abort/i,
  );
  f.port.listRetained = original;
  let release!: () => void;
  let late!: Promise<unknown>;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await ownerHttp(async () => {
    late = wait.then(() => f.proxy.media!.listRetained!({}, authority));
  });
  release();
  await assert.rejects(late, /no longer current/);
});
