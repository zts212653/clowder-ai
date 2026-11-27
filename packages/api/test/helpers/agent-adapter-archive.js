import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../../dist/domains/plugin/index.js';
import { tarArchive } from '../../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../../scripts/canonical-gzip.mjs';

const contractVersion = '0.4.0-candidate.0';
export const operations = ['describe', 'detect', 'openSession', 'startTurn', 'cancel', 'release'];
export const describe = (version) => ({
  protocolVersion: 1,
  label: `Fixture ${version}`,
  capabilities: {
    resume: { status: 'supported', data: { mode: 'native' } },
    tools: { status: 'unsupported' },
    login: { status: 'unknown', reason: 'not_configured' },
    input: { status: 'unsupported' },
    inspectInput: { status: 'unsupported' },
    compact: { status: 'unsupported' },
    modelCatalog: { status: 'unknown', reason: 'not_probed' },
    quota: { status: 'unsupported' },
  },
});

export async function setup(t, agentSessionImplementations, grantAgentAdapterNativeRuntime) {
  const temp = resolve(tmpdir());
  const projectRoot = await mkdtemp(join(temp, 'agent-adapter-admission-'));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    agentSessionImplementations,
    grantAgentAdapterNativeRuntime,
    messageStore: new MessageStore(),
    contract: { manifestContractRange: contractVersion, validateManifest },
  });
  t.after(async () => {
    await runtime.shutdown();
    assert.equal(dirname(projectRoot), temp);
    await rm(projectRoot, { recursive: true, force: true });
  });
  const { manager } = createPluginManagerRuntimeComposition({
    runtime,
    catalogManifests: [],
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
  });
  async function install({
    pluginId,
    version = '1.0.0',
    declaration,
    actionNames = operations,
    description = describe(version),
    hangingDescribe = false,
    detection = { candidates: [] },
    extraDeclarations = {},
    executable,
  }) {
    const manifest = {
      pluginId,
      name: pluginId,
      version,
      contractVersion,
      features: [{ id: 'agent', name: 'Agent adapter', capabilities: [], resources: [] }],
      runtime: { transport: 'builtin', entrypoint: 'entrypoint.mjs' },
    };
    assert.deepEqual(validateManifest(manifest).errors ?? [], []);
    const entrypoint =
      executable ??
      [
        'let observedAbort = false;',
        'export default { create: () => ({ start: () => ({',
        'actions: Object.fromEntries(' +
          JSON.stringify(actionNames) +
          ".map(name => [name, (input, control) => name === 'describe' ? " +
          (hangingDescribe
            ? `new Promise((_, reject) => {
              if (Object.keys(input).length !== 0 || !control?.signal) {
                reject(new Error('Missing separate adapter call context'));
                return;
              }
              control.signal.addEventListener('abort', () => {
                observedAbort = true;
                reject(control.signal.reason);
              }, { once: true });
            })`
            : JSON.stringify(description)) +
          " : name === 'detect' ? " +
          "(observedAbort ? { candidates: [{id: 'aborted', label: 'Aborted', state: {status: 'unavailable', reason: 'metadata_cancelled'}}] } : " +
          JSON.stringify(detection) +
          ') ' +
          ' : ({name})])),',
        'stop() {}',
        '}) }) };',
      ].join('\n');
    const archive = join(projectRoot, `${pluginId}-${version}.tgz`);
    const files = [
      ['manifest.json', JSON.stringify(manifest)],
      ['package.json', JSON.stringify({ name: pluginId, version, type: 'module' })],
      ...(declaration === undefined ? [] : [['agent-adapter.json', JSON.stringify(declaration)]]),
      ...Object.entries(extraDeclarations).map(([file, value]) => [file, JSON.stringify(value)]),
      ['entrypoint.mjs', entrypoint],
    ].map(([name, content]) => ({ name: `package/${name}`, bytes: Buffer.from(content) }));
    await writeFile(archive, canonicalGzip(tarArchive(files)));
    return manager.install({ source: { kind: 'local-archive', path: archive } });
  }
  return { manager, runtime, install };
}

export const declaration = (id) => ({ protocolVersion: 1, id, operations });
