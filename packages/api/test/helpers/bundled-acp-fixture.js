import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarArchive } from '../../scripts/bundled-plugin-artifacts.mjs';
import { canonicalGzip } from '../../scripts/canonical-gzip.mjs';

export const clients = [
  { id: 'codeagent', pluginId: 'official.codeagent', version: '0.1.0', command: 'codeagent', startupArgs: ['--acp'] },
  { id: 'relayagent', pluginId: 'relayagent', version: '1.0.0', command: 'python', startupArgs: ['-m', 'relay_acp'] },
];

export async function bundledAcpFixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'bundled-acp-admission-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // CLI guards resolve the runtime root above packages/api; keep their writes
  // inside this owned fixture on Unix as well as Windows.
  const root = join(workspace, 'packages/api');
  await mkdir(root, { recursive: true });
  const api = fileURLToPath(new URL('../../', import.meta.url));
  await cp(join(api, 'dist'), join(root, 'dist'), {
    recursive: true,
    filter: (path) => !/\.(?:map|d\.ts)$/.test(path),
  });
  await symlink(
    join(api, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const { imports } = JSON.parse(await readFile(join(api, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', imports }));
  await cp(join(api, 'runtime'), join(root, 'runtime'), { recursive: true });
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
  await mkdir(join(workspace, 'assets'));
  await cp(
    join(api, '../../assets/agy-native-tool-vocabulary.json'),
    join(workspace, 'assets/agy-native-tool-vocabulary.json'),
  );
  await cp(join(api, '../../cat-template.json'), join(workspace, 'cat-template.json'));
  const packages = join(root, 'dist/domains/plugin/bundled-packages');
  const original = JSON.parse(await readFile(join(packages, 'index.json'), 'utf8'));
  return {
    root,
    async bundle(client, { version = client.version, declaration, runtime, omitDeclaration = false } = {}) {
      const manifest = {
        pluginId: client.pluginId,
        version,
        contractVersion: '0.1.0',
        name: client.id,
        features: [{ id: client.id, name: client.id, resources: [], capabilities: ['plugin.config.read'] }],
        configuration: [{ key: 'connection', label: 'Connection', kind: 'string', required: false, default: '{}' }],
        ...(runtime ? { runtime } : {}),
      };
      const provider = declaration ?? {
        id: client.id,
        transport: 'acp',
        configurationKey: 'connection',
        acp: { command: client.command, startupArgs: client.startupArgs, permissionPolicy: 'deny' },
      };
      const files = [
        ...(runtime?.entrypoint
          ? [{ name: `package/${runtime.entrypoint}`, bytes: Buffer.from('process.stdin.resume();') }]
          : []),
        { name: 'package/plugin.yaml', bytes: Buffer.from(JSON.stringify(manifest)) },
        {
          name: 'package/package.json',
          bytes: Buffer.from(JSON.stringify({ name: `@fixture/${client.id}`, version })),
        },
        ...(!omitDeclaration
          ? [
              {
                name: 'package/agent-provider.json',
                bytes: Buffer.from(typeof provider === 'string' ? provider : JSON.stringify(provider)),
              },
            ]
          : []),
      ];
      const bytes = canonicalGzip(tarArchive(files));
      const entry = {
        catalogId: client.id,
        pluginId: client.pluginId,
        version,
        archiveUrl: `builtin://${client.id}/${version}`,
        packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        archivePath: `${client.id}/${version}/package.tgz`,
      };
      await mkdir(join(packages, client.id, version), { recursive: true });
      await writeFile(join(packages, entry.archivePath), bytes);
      await writeFile(join(packages, client.id, version, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(packages, 'index.json'), JSON.stringify({ ...original, [client.id]: entry }));
      return { ...entry, distribution: 'bundled', bundledFormat: 'archive', packageName: `@fixture/${client.id}` };
    },
    async run(entry, action = 'install') {
      await writeFile(join(root, 'case.json'), JSON.stringify({ entry, action }));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./bundled-acp-probe.mjs', import.meta.url))], {
        env: {
          ...process.env,
          BUNDLED_ACP_TEST_ROOT: root,
          BUNDLED_ACP_TEST_WORKSPACE_ROOT: workspace,
          CAT_TEMPLATE_PATH: join(workspace, 'cat-template.json'),
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const line = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'));
      assert.ok(line, result.stdout);
      return JSON.parse(line.slice(7));
    },
  };
}
