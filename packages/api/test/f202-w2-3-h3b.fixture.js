/**
 * F202 W2-3 h3b fixtures — module packages that host `cloud-conversation-host` (contract beta.24,
 * frozen h3), run through the real chain: lifecycle → carrier router (declared runtime
 * contributions) → bundled carrier → module runtime, with the module file loaded by a real
 * dynamic import.
 *
 * Every action a package exposes records its call in `calls()` and answers from `script[method]`:
 * a value, or a function of the input (which may return a promise or throw — a throw there is a
 * throw inside the package's action).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

export const METHODS = Object.freeze({
  append: 'conversation.append',
  list: 'conversation.returns.list',
  ack: 'conversation.returns.ack',
});

const FIXTURE = '__f202H3bFixture';
const roots = [];

export async function cleanup() {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** A temporary directory removed by `cleanup()`. */
export async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function hostManifest({ pluginId = 'dev.clowder.h3b-host', runtime } = {}) {
  return {
    pluginId,
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'H3b conversation host',
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        contributions: [{ type: 'cloud-conversation-host', id: 'chatgpt' }],
        capabilities: ['cloud.conversation.host'],
      },
    ],
    runtime: runtime ?? { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    contributions: [
      {
        type: 'cloud-conversation-host',
        id: 'chatgpt',
        provider: 'chatgpt',
        appendMessage: { method: METHODS.append },
        assistantReturns: { list: { method: METHODS.list }, ack: { method: METHODS.ack } },
      },
    ],
  };
}

export const validDiagnostic = Object.freeze({
  v: 1,
  errorCode: 'STALE_EXTENSION',
  nextAction: 'inspect_bound_tab',
  fingerprint: {
    v: 1,
    phase: 'compose',
    adapterRevision: 'a1',
    artifactRevision: 'r1',
    nodes: [{ path: 'composer/p[0]', kind: 'element', tag: 'P' }],
    truncated: false,
  },
});

function moduleSource(pluginId, methods) {
  return `
const fixture = globalThis[${JSON.stringify(FIXTURE)}];
const pluginId = ${JSON.stringify(pluginId)};
export default {
  create() {
    return {
      async start() {
        fixture.calls.push({ pluginId, method: 'start' });
        const actions = {};
        for (const method of ${JSON.stringify(methods)}) {
          actions[method] = (input) => {
            fixture.calls.push({ pluginId, method, input });
            const step = fixture.script[method];
            return typeof step === 'function' ? step(input, pluginId) : step;
          };
        }
        return {
          actions,
          async stop(reason) {
            fixture.calls.push({ pluginId, method: 'stop', reason });
            if (typeof fixture.script.stop === 'function') fixture.script.stop(reason, pluginId);
          },
        };
      },
    };
  },
};
`;
}

const digestOf = (seed) => `sha512-${createHash('sha512').update(seed).digest('base64')}`;

/**
 * @param packages `{ manifest, grants?, exposes? }` each; by default one package with the grant,
 *   exposing all three methods.
 * @param withRegistry false composes the Host without a registry, as production does until h3c.
 * @param registryOptions passed to the registry (its listener error hook).
 */
export async function conversationHostHarness({ packages, withRegistry = true, registryOptions } = {}) {
  const fixture = {
    calls: [],
    script: {
      [METHODS.append]: { status: 'appended', providerMessageId: 'provider-1' },
      [METHODS.list]: { returns: [] },
      [METHODS.ack]: { status: 'acknowledged' },
    },
  };
  globalThis[FIXTURE] = fixture;
  let now = 1_000;
  let nextInstance = 0;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => `pi_h3b_${++nextInstance}`,
    now: () => now++,
  });
  const located = new Map();
  const instances = [];
  for (const spec of packages ?? [{ manifest: hostManifest() }]) {
    const rootDir = await tempRoot('f202-h3b-package-');
    await mkdir(join(rootDir, 'dist'), { recursive: true });
    await writeFile(
      join(rootDir, 'dist/plugin.js'),
      moduleSource(spec.manifest.pluginId, spec.exposes ?? Object.values(METHODS)),
    );
    const digest = digestOf(rootDir);
    located.set(digest, { rootDir, manifest: spec.manifest });
    const installed = await inventory.installPackage({
      manifest: spec.manifest,
      computedPackageDigest: digest,
      expectedPackageDigest: digest,
      packagePluginId: spec.manifest.pluginId,
      effectiveGrants: spec.grants ?? ['cloud.conversation.host'],
    });
    instances.push(installed.pluginInstanceId);
  }
  const packageLocator = {
    resolveInstalledPackage: async (digest) => ({
      ...located.get(digest),
      verifyIntegrity: async () => {},
      release: async () => {},
    }),
  };
  const configuration = { readConfig: async () => undefined, readSecret: async () => undefined };
  const registry = new CloudConversationHostRegistry(registryOptions);
  const moduleRuntime = new ModulePluginRuntime({ packages: packageLocator, configuration, log: () => {} });
  const router = new PluginRuntimeCarrierRouter(store, undefined, {
    packages: packageLocator,
    configuration,
    ...(withRegistry ? { cloudConversationHosts: registry } : {}),
  });
  router.register(new BundledPluginRuntimeCarrier({ inventory: store, runtimes: [moduleRuntime], now: () => now++ }));
  const lifecycle = new ExternalPluginLifecycleService({ store, supervisor: router, now: () => now++ });
  const revision = async (pluginInstanceId) =>
    (await store.snapshot()).instances.find((instance) => instance.pluginInstanceId === pluginInstanceId)
      .lifecycleRevision;
  return {
    store,
    registry,
    router,
    moduleRuntime,
    instances,
    script: fixture.script,
    calls: (method) => fixture.calls.filter((call) => method === undefined || call.method === method),
    async enable(pluginInstanceId = instances[0]) {
      const prepared = await lifecycle.prepare(pluginInstanceId, await revision(pluginInstanceId));
      return lifecycle.enable(pluginInstanceId, prepared.lifecycleRevision);
    },
    async disable(pluginInstanceId = instances[0]) {
      return lifecycle.disable(pluginInstanceId, await revision(pluginInstanceId));
    },
  };
}

/** Lets every pending promise chain settle (the fakes here never use timers). */
export async function settle() {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}
