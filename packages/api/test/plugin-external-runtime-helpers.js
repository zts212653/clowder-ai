import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  HostBrokerControlPlane,
  HostInventoryControlPlane,
  MemoryHostBrokerStore,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

export const EXTERNAL_PLUGIN_ID = 'official.external-source';
export const EXTERNAL_INSTANCE_ID = 'pi_external';
export const EXTERNAL_PACKAGE_DIGEST = `sha512-${createHash('sha512').update('k2d-external-package').digest('base64')}`;

export function externalManifest(runtime = { transport: 'stdio', entrypoint: 'dist/plugin.js' }) {
  return {
    pluginId: EXTERNAL_PLUGIN_ID,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'External Source',
    features: [
      {
        id: 'source',
        name: 'Source',
        resources: [],
        capabilities: ['events.publish'],
      },
    ],
    signals: {
      provides: [
        {
          type: 'external.signal.v1',
          schemaRef: 'schemas/external.signal.v1.schema.json',
          epistemicStatus: 'observation',
          privacyClass: 'content-adjacent',
          sourceClass: 'remote-service',
        },
      ],
    },
    runtime,
  };
}

export function externalCandidate(overrides = {}) {
  return {
    pluginId: EXTERNAL_PLUGIN_ID,
    packageDigest: EXTERNAL_PACKAGE_DIGEST,
    contractVersion: '0.1.0',
    wireVersion: '0.1.0',
    ...overrides,
  };
}

export function externalPublishInput(overrides = {}) {
  return {
    signalType: 'external.signal.v1',
    eventId: 'event-1',
    idempotencyKey: 'publish-1',
    occurredAt: '2026-08-10T12:00:00Z',
    payload: { artifactId: 'artifact-1' },
    source: { handle: 'external://artifact/1' },
    ...overrides,
  };
}

export async function createExternalRuntimeHarness({
  rootDir,
  manifest = externalManifest(),
  methods = [],
  packageDigest = EXTERNAL_PACKAGE_DIGEST,
  activeLeaseTtlMs,
  brokerStore = new MemoryHostBrokerStore(),
  now = Date.now,
} = {}) {
  if (!rootDir) throw new TypeError('rootDir is required');
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(join(rootDir, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');

  const inventory = new MemoryPluginInventoryStore();
  const inventoryControl = new HostInventoryControlPlane(inventory, {
    createInstanceId: () => EXTERNAL_INSTANCE_ID,
    now: () => 1_000,
  });
  await inventoryControl.installPackage({
    manifest,
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: EXTERNAL_PLUGIN_ID,
    effectiveGrants: ['events.publish'],
    signalSchemas: {
      'schemas/external.signal.v1.schema.json': {
        type: 'object',
        properties: { payload: { type: 'object' }, source: { type: 'object' } },
        required: ['payload', 'source'],
      },
    },
  });
  await inventory.transaction((transaction) => {
    const instance = transaction.instances.get(EXTERNAL_INSTANCE_ID);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: 1_001,
    });
  });

  let connectionSequence = 0;
  let sessionSequence = 0;
  let leaseSequence = 0;
  let nonceSequence = 0;
  const nextId = (prefix, sequence) => (sequence === 0 ? prefix : `${prefix}_${sequence + 1}`);
  const broker = new HostBrokerControlPlane({
    inventory,
    store: brokerStore,
    methods,
    now,
    createConnectionId: () => nextId('conn_external', connectionSequence++),
    createSessionId: () => nextId('bs_external', sessionSequence++),
    createRuntimeLeaseId: () => nextId('lease_external', leaseSequence++),
    createBindingNonce: () => nextId('nonce_external', nonceSequence++),
    ...(activeLeaseTtlMs === undefined ? {} : { activeLeaseTtlMs }),
  });

  return { inventory, brokerStore, broker, manifest, rootDir };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class FakeExternalPluginProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  terminateCalls = 0;
  #exit = deferred();
  exited = this.#exit.promise;

  async terminate() {
    this.terminateCalls += 1;
    this.exit({ code: null, signal: 'SIGTERM' });
  }

  exit(result = { code: 1, signal: null }) {
    this.#exit.resolve(result);
    this.stdout.end();
    this.stderr.end();
  }
}

export class FakePluginProcessAdapter {
  specs = [];
  processes = [];
  #spawned = deferred();

  async spawn(spec) {
    this.specs.push(structuredClone(spec));
    const child = new FakeExternalPluginProcess();
    this.processes.push(child);
    this.#spawned.resolve(child);
    return child;
  }

  async nextProcess() {
    return this.processes.at(-1) ?? this.#spawned.promise;
  }

  async waitForProcess(index, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.processes[index] === undefined) {
      if (Date.now() >= deadline) throw new Error(`plugin process ${index + 1} did not start before deadline`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return this.processes[index];
  }
}

export function wireRequest(id, method, input, deadlineUnixMs = Date.now() + 60_000) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: { meta: { deadlineUnixMs }, input },
  };
}

export function sendFrame(child, frame) {
  child.stdout.write(`${JSON.stringify(frame)}\n`);
}

export async function readFrame(child) {
  const newline = await new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (chunk) => {
      chunks.push(Buffer.from(chunk));
      const combined = Buffer.concat(chunks);
      const index = combined.indexOf(0x0a);
      if (index === -1) return;
      cleanup();
      resolve(combined.subarray(0, index));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdin.off('data', onData);
      child.stdin.off('error', onError);
    };
    child.stdin.on('data', onData);
    child.stdin.on('error', onError);
  });
  return JSON.parse(newline.toString('utf8'));
}

export async function completeExternalHandshake(child, candidate = externalCandidate()) {
  sendFrame(child, wireRequest('hello-1', 'broker.hello', candidate));
  const hello = await readFrame(child);
  sendFrame(child, wireRequest('ready-1', 'broker.ready', { bindingNonce: hello.result.bindingNonce }));
  const ready = await readFrame(child);
  return { hello, ready };
}
