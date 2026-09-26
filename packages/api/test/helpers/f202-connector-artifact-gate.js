/**
 * F202 C1 cross-repository gate — approved connector artifacts run on the Host's real delivery path.
 *
 * Package admission, the publishing seam and the W2-5b outbound media job, SubscriptionDelivery
 * (real presentation builder, per-delivery media grants), the caller-bound subscription session and
 * the plugin media read service are all Host code. Only the IM platform adapter is a probe: it
 * records calls and drains media streams the way an uploader would. Nothing here substitutes an
 * artifact that is not the pinned one — a missing archive skips.
 */
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createMessagingDomain } from '../../dist/domains/messaging/index.js';
import { buildDeliveryPresentation } from '../../dist/domains/messaging/lifecycle-delivery.js';
import { MediaEntitlementLedger, MemoryMediaEntitlementPort } from '../../dist/domains/messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../../dist/domains/messaging/media-ledger.js';
import { createHostMediaPathResolver } from '../../dist/domains/messaging/outbound-media/host-media-paths.js';
import { OutboundMediaPublication } from '../../dist/domains/messaging/outbound-media/publication.js';
import { MemoryOutboundMediaStore } from '../../dist/domains/messaging/outbound-media/store.js';
import { createPublishingMessageStore } from '../../dist/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../../dist/domains/messaging/stores/factory.js';
import { createSubscriptionDelivery } from '../../dist/domains/messaging/subscription-delivery.js';
import {
  createPluginMediaHost,
  PluginMediaReadService,
} from '../../dist/domains/plugin/host-surface/plugin-media-host.js';
import { createPluginMessagingSubscriptionSession } from '../../dist/domains/plugin/host-surface/plugin-messaging-subscription-host.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  packageDirectoryName,
} from '../../dist/domains/plugin/index.js';
import { MemoryConnectorThreadBindingStore } from '../../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';
import { archiveFileName } from './f202-connector-artifact-pins.js';

export { RELEASES } from './f202-connector-artifact-pins.js';

const execFile = promisify(execFileCallback);

export const archiveDirectory = process.env.F202_W25PH_ARCHIVE_DIR;
export const OWNER = 'owner-1';
/** What the Host's cat registry would resolve `opus` to; the packages must show this, not the id. */
export const DISPLAY_NAME = '布偶猫宪宪';

function archivePath(release) {
  return join(archiveDirectory, archiveFileName(release));
}

/** Why this release cannot run here, or nothing when its pinned archive is present. */
export async function unavailable(release) {
  if (!archiveDirectory) return `set F202_W25PH_ARCHIVE_DIR; ${release.name} requires SHA-256 ${release.sha}`;
  try {
    await access(archivePath(release));
    return undefined;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return `${release.name} artifact absent; requires SHA-256 ${release.sha}`;
  }
}

/** Admit the pinned archive through the Host installer and import its declared entrypoint. */
export async function admitAndLoad(release, root) {
  const archive = archivePath(release);
  const bytes = await readFile(archive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha, `${release.name} approved artifact`);
  const packagesRoot = join(root, 'packages');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => `pi_${release.name}`,
    now: () => 12_000,
  });
  const grantPolicy = (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]);
  const admission = new LocalPluginPackageAdmission({ inventory, packagesRoot, grantPolicy });
  const installed = await admission.install({ kind: 'local-archive', path: archive });
  const row = (await store.snapshot()).packages.find(({ packageDigest }) => packageDigest === installed.packageDigest);
  assert.equal(row?.provenance.dependencyClosure, 'shipped');
  const extracted = join(root, 'extracted');
  await mkdir(extracted, { recursive: true });
  const admitted = join(packagesRoot, packageDirectoryName(installed.packageDigest), 'package.tgz');
  await execFile('tar', ['-xzf', admitted, '-C', extracted]);
  const packageRoot = await realpath(join(extracted, 'package'));
  const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
  const entrypoint = await realpath(join(packageRoot, manifest.runtime.entrypoint));
  assert.ok(entrypoint.startsWith(`${packageRoot}/`), 'runtime entrypoint must stay inside admitted package');
  const namespace = await import(pathToFileURL(entrypoint).href);
  assert.equal(typeof namespace[release.factory], 'function');
  return { manifest, factory: namespace[release.factory], grants: grantPolicy(manifest) };
}

/** The IM platform adapter: every call recorded; a media stream is drained as an uploader would. */
function adapterProbe() {
  let calls = [];
  const record =
    (method) =>
    async (...args) => {
      if (method === 'sendMedia') {
        const [externalId, media] = args;
        const chunks = [];
        for await (const chunk of media.content) chunks.push(Buffer.from(chunk));
        calls.push({ method, args: [externalId, { ...media, content: Buffer.concat(chunks) }] });
        return;
      }
      calls.push({ method, args });
    };
  const methods = ['sendRichMessage', 'sendReply', 'sendFormattedReply', 'sendMedia', 'onDeliveryBatchDone'];
  return {
    /** Calls since the previous take, without the batch bookkeeping hook. */
    take() {
      const taken = calls.filter(({ method }) => method !== 'onDeliveryBatchDone');
      calls = [];
      return taken;
    },
    runtime: {
      start: async () => undefined,
      stop: async () => undefined,
      outbound: Object.fromEntries(methods.map((method) => [method, record(method)])),
    },
  };
}

/** The Host composition for one gate run, rooted in a temporary directory. */
export async function createGateHost(root) {
  for (const dir of ['uploads', 'tts', 'connector-media', 'web']) await mkdir(join(root, dir), { recursive: true });
  const inner = new MessageStore();
  const threads = new ThreadStore();
  const stores = createMessagingStores();
  const ledger = new FileMessagingMediaLedger(join(root, 'media'));
  const entitlements = new MediaEntitlementLedger(new MemoryMediaEntitlementPort());
  const failures = [];
  const publication = new OutboundMediaPublication({
    store: new MemoryOutboundMediaStore(),
    messages: inner,
    events: stores.events,
    ledger,
    resolvePath: createHostMediaPathResolver({
      uploadDir: join(root, 'uploads'),
      ttsCacheDir: join(root, 'tts'),
      connectorMediaDir: join(root, 'connector-media'),
      webPublicDir: join(root, 'web'),
    }),
    onPublishFailure: (error) => failures.push(error),
  });
  const messageStore = createPublishingMessageStore(inner, {
    events: stores.events,
    publications: stores.publications,
    outboundMedia: () => publication,
    onPublishFailure: (error) => failures.push(error),
  });
  const messaging = createMessagingDomain({ messageStore, stores });
  const actions = new Map();
  const deliveryErrors = [];
  // Same composition as index.ts `deliveryPresentation`: the registry supplies the cat's name.
  const presentation = async (threadId, actor) => {
    const thread = await threads.get(threadId);
    return buildDeliveryPresentation(
      threadId,
      { ...actor, ...(actor.kind === 'cat' ? { displayName: DISPLAY_NAME } : {}) },
      { threadShortId: threadId.slice(0, 15), ...(thread?.title ? { threadTitle: thread.title } : {}) },
    );
  };
  const delivery = createSubscriptionDelivery({
    messaging,
    presentation,
    entitlements,
    onError: (fields) => deliveryErrors.push(fields),
    delivery: {
      async deliver() {
        throw new Error('module subscriptions use their declared action');
      },
      async invoke(instanceId, method, params) {
        const action = actions.get(instanceId)?.[method];
        if (!action) throw new Error(`${instanceId} has no action ${method}`);
        await action(params);
      },
    },
  });
  const mediaReads = new PluginMediaReadService({ ledger, entitlements });

  return {
    threads,
    failures,
    deliveryErrors,
    /** Start the admitted package as the Host's module carrier would, bound to one thread. */
    async start(release, loaded, threadId) {
      const instanceId = `pi_${release.name}`;
      const session = createPluginMessagingSubscriptionSession({
        pluginId: loaded.manifest.id,
        pluginInstanceId: instanceId,
        ownerUserId: OWNER,
        effectiveGrants: loaded.grants,
        threadStore: threads,
        bindingStore: new MemoryConnectorThreadBindingStore(),
        messaging,
        delivery,
        manifest: loaded.manifest,
      });
      const probe = adapterProbe();
      const media = createPluginMediaHost(mediaReads, { pluginInstanceId: instanceId, effectiveGrants: loaded.grants });
      const configValues = {
        appKey: 'k',
        appId: 'a',
        corpId: 'c',
        agentId: 'g',
        botId: 'b',
        accessKey: 'x',
        botToken: 't',
      };
      const host = {
        config: { get: async (key) => configValues[key] },
        secrets: { get: async () => 'fixture-secret' },
        state: { get: async () => null, set: async () => undefined },
        threads: { listBindings: async () => [{ threadId, key: 'external-1' }] },
        messaging: session.host,
        media,
        log: () => undefined,
      };
      const active = await loaded
        .factory(() => probe.runtime)
        .create(loaded.manifest)
        .start(host);
      actions.set(instanceId, active.actions);
      return { probe, media, grants: loaded.grants, stop: () => active.stop() };
    },
    /** A cat reply through the publishing seam, its media job, and one drain of the thread. */
    async catReply(threadId, blocks) {
      const stored = await messageStore.append({
        threadId,
        userId: OWNER,
        catId: 'opus',
        content: 'rich reply',
        mentions: [],
        timestamp: Date.now(),
        ...(blocks.length === 0 ? {} : { extra: { rich: { v: 1, blocks } } }),
      });
      await publication.schedule(stored.id);
      await delivery.drain(threadId);
      const events = await stores.events.readAfter(threadId, 0, 100);
      const event = events.find((e) => e.type === 'message.publish' && e.envelope.messageId === stored.id);
      assert.ok(event, 'the reply was published');
      return event.envelope;
    },
  };
}

/** The name an adapter call shows for the author: card header, formatted header, or reply prefix. */
export function shownAuthor(call) {
  if (call.method === 'sendRichMessage') return call.args[3];
  if (call.method === 'sendFormattedReply') return call.args[1].header;
  if (call.method === 'sendReply') return /^【(.+?)🐱】\n/.exec(call.args[1])?.[1];
  return undefined;
}
