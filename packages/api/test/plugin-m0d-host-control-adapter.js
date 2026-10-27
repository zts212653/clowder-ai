import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
} from './plugin-external-runtime-helpers.js';
import { actualInstanceId, prepareFixture } from './plugin-m0d-fixture-setup.js';
import { createMessagingOwner } from './plugin-m0d-messaging-owner.js';
import {
  ObservedNodeProcessAdapter,
  publishAcceptanceArchive,
  stageAcceptancePackage,
} from './plugin-m0d-process-fixture.js';

function error(errorCode) {
  return { status: 'error', errorCode };
}

export class HostControlBehaviorAdapter {
  #observations = {};
  #roots = [];

  constructor(behaviorCase) {
    this.behaviorCase = behaviorCase;
    this.pluginInstanceId = behaviorCase.given.caller.pluginInstanceId;
  }

  async setup(given) {
    if (this.behaviorCase.when.operation === 'deliverOnMessage') {
      await this.#setupDelivery(given);
      return;
    }
    if (this.behaviorCase.when.operation === 'deleteReplayEvents') {
      await this.#setupReplay(given);
      return;
    }
    throw new Error('unsupported Host control operation');
  }

  async #setupReplay(given) {
    this.messagingOwner = await createMessagingOwner(500);
    await prepareFixture(this.messagingOwner, this.behaviorCase, 500);
    const callerId = given.caller.pluginInstanceId;
    this.pluginInstanceId = actualInstanceId(callerId, callerId);
    this.rawHostErrorCode = undefined;
    this.replayEvents = structuredClone(given.state.replayEvents ?? []);
  }

  async #setupDelivery(_given) {
    const packageRoot = await mkdtemp(join(resolve('.'), '.m0d-host-control-'));
    const hostRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-m0d-delivery-'));
    this.#roots.push(packageRoot, hostRoot);
    const packagesRoot = join(packageRoot, 'packages');
    const manifest = externalManifest();
    const runtime = await import('../dist/domains/plugin/external-runtime/index.js');
    const { archivePath, packageDigest } = await stageAcceptancePackage(packageRoot, this.behaviorCase, manifest);
    this.packageDigest = packageDigest;
    await mkdir(packagesRoot, { recursive: true });
    await publishAcceptanceArchive(packagesRoot, archivePath, packageDigest, runtime.packageDirectoryName);
    const harness = await createExternalRuntimeHarness({
      rootDir: hostRoot,
      manifest,
      packageDigest,
    });
    this.store = harness.inventory;
    this.pluginInstanceId = EXTERNAL_INSTANCE_ID;
    this.rawHostErrorCode = undefined;
    this.processes = new ObservedNodeProcessAdapter(new runtime.NodeExternalPluginProcessAdapter(100));
    this.supervisor = new runtime.ExternalPluginRuntimeSupervisor({
      inventory: harness.inventory,
      broker: harness.broker,
      packages: new runtime.FilesystemVerifiedPluginPackageLocator(packagesRoot),
      processes: this.processes,
      handshakeTimeoutMs: 2_000,
    });
    await this.supervisor.start(this.pluginInstanceId);
  }

  async #observe(target) {
    if (this.behaviorCase.when.operation === 'deleteReplayEvents') {
      if (target === 'messages') return structuredClone(await this.messagingOwner.messageStore.getRecent(2_000));
      if (target === 'replay_events') return this.#observeReplayEvents();
      throw new Error(`unsupported replay-retention observation target ${target}`);
    }
    if (this.behaviorCase.when.operation === 'deliverOnMessage') {
      if (target === 'messages' || target === 'output_events') return [];
      throw new Error(`unsupported Host-delivery observation target ${target}`);
    }
    throw new Error(`unsupported Host-control observation target ${target}`);
  }

  async observe(target) {
    const snapshot = structuredClone(await this.#observe(target));
    (this.#observations[target] ??= []).push(snapshot);
    return structuredClone(snapshot);
  }

  get observations() {
    return structuredClone(this.#observations);
  }

  async execute(operation) {
    this.rawHostErrorCode = undefined;
    switch (operation.operation) {
      case 'deliverOnMessage':
        return this.#deliverOnMessage(operation.input);
      case 'deleteReplayEvents':
        return this.#deleteReplayEvents(operation.input);
      default:
        throw new Error(`unsupported Host-control operation ${operation.operation}`);
    }
  }

  async #deliverOnMessage(input) {
    try {
      await this.supervisor.deliver(this.pluginInstanceId, {
        deliveryId: 'm0d-delivery',
        kind: 'message',
        threadId: input.envelope.threadId,
        envelope: {
          ...input.envelope,
          revision: 1,
          actor: { kind: 'plugin', id: this.pluginInstanceId },
          audience: { kind: 'public' },
          occurredAt: '2026-10-23T00:00:00.000Z',
          payload: {
            provenance: { origin: { kind: 'plugin', instanceId: this.pluginInstanceId }, epistemicStatus: 'inference' },
            elements: [{ elementId: 'm0d-delivery-text', kind: 'text', payload: { text: 'fixture delivery' } }],
          },
        },
      });
      return { status: 'success' };
    } catch (caught) {
      if (caught?.code !== 'DELIVERY_REJECTED') throw caught;
      this.rawHostErrorCode = caught.cause?.code ?? caught.code;
      return error('PERMISSION');
    }
  }

  async #observeReplayEvents() {
    const callerId = this.behaviorCase.given.caller.pluginInstanceId;
    const retained = [];
    for (const replayEvent of this.replayEvents) {
      const handle = Object.values(this.behaviorCase.given.handles).find(
        (candidate) => candidate.kind === 'subscription' && candidate.subscriptionId === replayEvent.subscriptionId,
      );
      if (!handle) throw new Error(`replay event ${replayEvent.eventId} omitted its subscription handle`);
      const ownerId = actualInstanceId(handle.ownerPluginInstanceId, callerId);
      // eslint-disable-next-line no-await-in-loop
      const cursor = await this.messagingOwner.cursorStore.get(ownerId, handle.subscriptionId);
      if (!cursor || replayEvent.sequence > cursor.replayFloorSequence) retained.push(replayEvent);
    }
    return structuredClone(retained);
  }

  async #deleteReplayEvents(input) {
    try {
      await this.messagingOwner.stream.deleteReplayEvents(
        { pluginInstanceId: this.pluginInstanceId },
        input.subscriptionId,
        input.throughSequence,
      );
      return { status: 'success' };
    } catch (caught) {
      if (caught?.name !== 'MessagingError') throw caught;
      this.rawHostErrorCode = caught.code;
      return error(caught.code);
    }
  }

  async close() {
    if (this.supervisor) await this.supervisor.stop(this.pluginInstanceId, 'acceptance_complete');
    for (const root of this.#roots) await rm(root, { recursive: true, force: true });
    this.#roots = [];
  }
}
