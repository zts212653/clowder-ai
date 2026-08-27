import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';

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

export const OPERATION_METHODS = Object.freeze({
  send: 'messaging.send',
  appendElements: 'messaging.appendElements',
  subscribe: 'messaging.subscribe',
  read: 'messaging.read',
  ack: 'messaging.ack',
  snapshot: 'messaging.snapshot',
});

let sharedNodeProcessAdapter;

export class ExternalStdioBehaviorAdapter {
  #owner;
  #outcome;
  #supervisor;
  #roots = [];
  #threadIds = new Set();

  constructor(behaviorCase) {
    this.behaviorCase = behaviorCase;
  }

  async setup() {
    const window = this.behaviorCase.given.state.eventWindow;
    const retentionCount = window ? window.headSequence - window.oldestSequence + 1 : 500;
    this.#owner = await createMessagingOwner(retentionCount);
    const prepared = await prepareFixture(this.#owner, this.behaviorCase, retentionCount);
    this.#threadIds = prepared.threadIds;

    const packageRoot = await mkdtemp(join(resolve('.'), '.m0d-joint-acceptance-'));
    const hostRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-m0d-host-'));
    this.#roots.push(packageRoot, hostRoot);
    const packagesRoot = join(packageRoot, 'packages');
    const manifest = externalManifest();
    manifest.features[0].capabilities = [...this.behaviorCase.given.grants];
    const [
      { NodeExternalPluginProcessAdapter, FilesystemVerifiedPluginPackageLocator, packageDirectoryName },
      handlers,
    ] = await Promise.all([
      import('../dist/domains/plugin/external-runtime/index.js'),
      import('../dist/domains/plugin/host-broker/messaging-handler.js'),
    ]);
    const { archivePath, packageDigest } = await stageAcceptancePackage(packageRoot, prepared.translatedCase, manifest);
    this.packageDigest = packageDigest;
    await mkdir(packagesRoot, { recursive: true });
    await publishAcceptanceArchive(packagesRoot, archivePath, packageDigest, packageDirectoryName);
    const harness = await createExternalRuntimeHarness({
      rootDir: hostRoot,
      manifest,
      effectiveGrants: this.behaviorCase.given.grants,
      packageDigest,
      methods: handlers.createMessagingBrokerHandlers({ messaging: this.#owner.messaging }),
    });
    sharedNodeProcessAdapter ??= new NodeExternalPluginProcessAdapter(100);
    const processes = new ObservedNodeProcessAdapter(sharedNodeProcessAdapter);
    const Supervisor = (await import('../dist/domains/plugin/external-runtime/supervisor.js'))
      .ExternalPluginRuntimeSupervisor;
    this.#supervisor = new Supervisor({
      inventory: harness.inventory,
      broker: harness.broker,
      packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
      processes,
      handshakeTimeoutMs: 2_000,
    });
    this.processes = processes;
  }

  async #observeOutputEvents() {
    const rows = [];
    for (const threadId of [...this.#threadIds].sort()) {
      const events = await this.#owner.events.readAfter(threadId, 0, 2_000);
      rows.push(...events.map((event) => ({ threadId, event })));
    }
    return structuredClone(rows);
  }

  async #observeSubscription() {
    if (this.#outcome && this.behaviorCase.when.operation === 'read') return this.#outcome.result;
    const records = [];
    const callerId = this.behaviorCase.given.caller.pluginInstanceId;
    for (const handle of Object.values(this.behaviorCase.given.handles)) {
      if (handle.kind !== 'subscription') continue;
      records.push(
        await this.#owner.cursorStore.get(
          actualInstanceId(handle.ownerPluginInstanceId, callerId),
          handle.subscriptionId,
        ),
      );
    }
    return structuredClone(records);
  }

  async #observeSnapshot() {
    if (!this.#outcome?.roundTrip) return undefined;
    const subscription = Object.values(this.behaviorCase.given.handles).find(
      (handle) => handle.kind === 'subscription',
    );
    if (!subscription) return undefined;
    const record = await this.#owner.cursorStore.get(EXTERNAL_INSTANCE_ID, subscription.subscriptionId);
    if (!record || this.#outcome.roundTrip.resumed.events.length !== 0) return undefined;
    return {
      operation: 'snapshot',
      resumeSequence: record.ackedSequence,
      nextReadStartsAfter: record.ackedSequence,
    };
  }

  async observe(target) {
    switch (target) {
      case 'messages':
        return structuredClone(await this.#owner.messageStore.getRecent(2_000));
      case 'output_events':
        return this.#observeOutputEvents();
      case 'idempotency_ledger':
        return structuredClone(this.#owner.ledgerStore.snapshot());
      case 'reply_preview':
        return undefined;
      case 'provenance':
        return (await this.#owner.messageStore.getRecent(2_000)).map(
          (message) => message.extra?.pluginMessage?.provenance,
        );
      case 'subscription':
        return this.#observeSubscription();
      case 'snapshot':
        return this.#observeSnapshot();
      default:
        throw new Error(`unsupported Host observation target ${target}`);
    }
  }

  async execute() {
    await this.#supervisor.start(EXTERNAL_INSTANCE_ID);
    try {
      this.#outcome = await this.processes.waitForOutcome();
    } catch (error) {
      throw new Error(
        `${this.behaviorCase.id}: ${error.message}; stderr=${JSON.stringify(this.processes.diagnostics)}`,
        { cause: error },
      );
    }
    if (this.#outcome.status === 'success') return { status: 'success' };
    return {
      status: 'error',
      ...(typeof this.#outcome.error?.data?.code === 'string' ? { errorCode: this.#outcome.error.data.code } : {}),
    };
  }

  get outcome() {
    return structuredClone(this.#outcome);
  }

  async close() {
    if (this.#supervisor) await this.#supervisor.stop(EXTERNAL_INSTANCE_ID, 'acceptance_complete');
    for (const root of this.#roots) await rm(root, { recursive: true, force: true });
  }
}

export function classifyWireCase(behaviorCase) {
  const method = OPERATION_METHODS[behaviorCase.when.operation];
  if (!method) return { transport: 'host-admin', wireValid: null };
  return {
    transport: 'child-stdio',
    method,
    wireValid: validateMessagingRowInput(method, behaviorCase.when.input).valid,
  };
}
