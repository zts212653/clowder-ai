import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DesktopWindowContribution, PluginManifest } from '@clowder-ai/plugin-contract';
import { validateManifest as validateDeskManifest } from '@clowder-ai/plugin-contract-033c0';
import { companionCommandValidator } from '../src/domains/plugin/desktop-window-runtime/admission.js';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import { validateHostPluginManifest } from '../src/domains/plugin/desktop-window-runtime/presentation-manifest.js';
import {
  COMPANION_ARCHIVE_CONTRACTS,
  COMPANION_CAPABILITY_SINCE,
  COMPANION_CONTRACT_LINES,
  companionContractHas,
  resolveCompanionArchiveContract,
} from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { snapshotPluginSurfaceAssets } from '../src/domains/plugin/external-runtime/package-surface-assets.js';
import { modernCompanionInstallFixture as fixture, livingBodyHtml } from './helpers/f317-companion-install-fixture.js';

// F336 Phase C U8, Host side: contract line 0.3.3-candidate.3 (livingBody, bridge 1.8.0) and companion
// 0.1.0-alpha.38 from clowder-ai-plugins #240 (28f2b77b).
const require = createRequire(import.meta.url);
const kernel = require('../../../desktop/plugin-window/companion-contracts.cjs');
const LIVING = '0.3.3-candidate.3';
const ALPHA38 = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.38',
  // catalog/candidate.json at clowder-ai-plugins main (shasum 6d8e3182e9eae01a43f4dd40baf450c51ad4a4b3).
  packageDigest: 'sha512-Rfi8xNXa1eRvqCkeOiNmQHJAKIxTCAfnml5ggPu03h010w+M1QxsJ1hLutIxIMTYdhQLJWYiYfmYtH6yI0wh8w==',
};
// packages/companion/plugin.yaml of that release.
const SURFACE_SRI = 'sha256-YJjSElnuiUD+Ou5LqJb/uG7WW8isd19/pK7/JWIj6cU=';
const BODY_SRI = 'sha256-qjwqqih/ZLTTjcDTS4NVhvHTmTMumaQwviCgbQejakU=';
const ALPHA38_MANIFEST = {
  pluginId: 'official.companion',
  version: '0.1.0-alpha.38',
  contractVersion: '0.1.0',
  name: '猫猫球',
  icon: { type: 'png', src: 'renderer/skins/ragdoll-v1.png' },
  description: {
    default: 'Talk, think and find your shared history with your companion.',
    translations: { 'zh-CN': '和猫猫说话、查资料，回到同一段聊天继续工作。' },
  },
  runtime: { transport: 'builtin' },
  features: [
    { id: 'companion', name: '猫猫球', resources: [], contributions: [{ type: 'desktop-window', id: 'companion' }] },
  ],
  contributions: [
    {
      type: 'desktop-window',
      id: 'companion',
      role: 'companion',
      bridgeVersion: '1.8.0',
      surface: { entrypoint: 'renderer/index.html', integrity: SURFACE_SRI },
      body: { entrypoint: 'renderer/body.html', integrity: BODY_SRI },
      presentation: { width: 300, height: 270, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
    },
  ],
};
const withContribution = (patch: Record<string, unknown>) => ({
  ...ALPHA38_MANIFEST,
  contributions: ALPHA38_MANIFEST.contributions.map((c) => ({ ...c, ...patch })),
});

test('the kernel and the Host admit the same lines; livingBody starts at 0.3.3-candidate.3', () => {
  assert.deepEqual([...kernel.COMPANION_CONTRACT_LINES], [...COMPANION_CONTRACT_LINES]);
  assert.deepEqual({ ...kernel.COMPANION_CAPABILITY_SINCE }, { ...COMPANION_CAPABILITY_SINCE });
  for (const contract of [...COMPANION_CONTRACT_LINES, '0.3.3-candidate.1', '0.3.3-candidate.2', undefined])
    assert.equal(kernel.companionContractHas(contract, 'livingBody'), contract === LIVING, String(contract));
  assert.equal(companionContractHas(LIVING, 'desk'), true, 'the living line keeps the desk');
  assert.equal(companionContractHas(LIVING, 'appAssist'), true);
});

test('alpha.38 is admitted only by its exact SRI, as the livingBody line', () => {
  assert.equal(resolveCompanionArchiveContract(ALPHA38), LIVING);
  assert.equal(
    resolveCompanionArchiveContract({ ...ALPHA38, packageDigest: `${ALPHA38.packageDigest.slice(0, -4)}AA==` }),
    undefined,
  );
  assert.equal(resolveCompanionArchiveContract({ ...ALPHA38, version: '0.1.0-alpha.39' }), undefined);
  assert.equal(resolveCompanionArchiveContract({ ...ALPHA38, pluginId: 'dev.other' }), undefined);
});

test('bridge 1.8.0 and its body entry are admitted only for the shipped alpha.38 manifest', () => {
  const admitted = validateHostPluginManifest(ALPHA38_MANIFEST);
  assert.equal(admitted.valid, true);
  if (admitted.valid) assert.deepEqual(admitted.manifest, ALPHA38_MANIFEST, 'manifest bytes are never rewritten');
  for (const refused of [
    { ...ALPHA38_MANIFEST, version: '0.1.0-alpha.37' }, // the desk release's row reads candidate.0
    { ...ALPHA38_MANIFEST, version: '0.1.0-alpha.39' }, // no row: what an old Host sees for any new release
    { ...ALPHA38_MANIFEST, pluginId: 'dev.other' },
    withContribution({ bridgeVersion: '1.7.0' }), // a body entry needs bridge 1.8.0
    withContribution({
      body: { entrypoint: 'renderer/index.html', integrity: SURFACE_SRI },
    }),
    withContribution({
      body: { entrypoint: 'other/body.html', integrity: BODY_SRI },
    }),
  ])
    assert.equal(validateHostPluginManifest(refused).valid, false, JSON.stringify(refused.version));
});

test('old Host + new package is refused: no archive row, no line, and the older reader rejects bridge 1.8.0', () => {
  const oldTable = COMPANION_ARCHIVE_CONTRACTS.filter((row) => row.contract !== LIVING);
  assert.equal(resolveCompanionArchiveContract(ALPHA38, oldTable), undefined, 'the runtime then refuses to start');
  assert.equal(validateDeskManifest(ALPHA38_MANIFEST).valid, false, "candidate.0's reader, the old Host's newest");
  assert.equal(kernel.isCompanionContract('0.3.3-candidate.4'), false, 'a line a kernel does not list has nothing');
});

test('body and scene commands and the living skin exist only on the livingBody line', () => {
  const commands = [
    { kind: 'body.hit', rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
    { kind: 'body.hit.renew' },
    { kind: 'body.anchor', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { kind: 'body.menu' },
    { kind: 'scene.get' },
    { kind: 'scene.report', snapshot: { schemaVersion: 1, hat: { askew: true } }, dirty: ['hat'] },
    { kind: 'settings.update', field: 'skin', value: 'xianxian-living' },
  ];
  for (const command of commands) {
    assert.equal(companionCommandValidator(LIVING)(command), true, command.kind);
    assert.equal(companionCommandValidator('0.3.3-candidate.0')(command), false, command.kind);
  }
});

test('through installation the runtime opens the verified body page beside the surface, and serves it', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.38');
  assert.equal(f.launch.companionContract, LIVING);
  const surface = new URL(f.launch.url);
  assert.ok(f.launch.bodyUrl);
  const body = new URL(f.launch.bodyUrl);
  assert.equal(body.origin, surface.origin);
  assert.equal(body.pathname, surface.pathname.replace(/index\.html$/, 'body.html'));
  const served = await new Promise<{ status?: number; csp?: string; text: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: body.port, path: body.pathname, headers: { host: body.host } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, csp: String(res.headers['content-security-policy']), text }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(served.status, 200);
  assert.equal(served.text, livingBodyHtml);
  assert.match(served.csp ?? '', /connect-src 'none'/, 'under the same static-surface policy');
});

test('a body page whose bytes do not match its integrity refuses the whole surface', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f336-body-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'renderer'));
  const surfaceHtml = '<!doctype html><title>panel</title>';
  await writeFile(join(root, 'renderer/index.html'), surfaceHtml);
  await writeFile(join(root, 'renderer/body.html'), livingBodyHtml);
  const sri = (text: string) => `sha256-${createHash('sha256').update(text).digest('base64')}`;
  const pkg = {
    rootDir: root,
    manifest: ALPHA38_MANIFEST as unknown as PluginManifest,
    verifyIntegrity: async () => {},
    release: async () => {},
  };
  const contribution = (bodyIntegrity: string) =>
    ({
      type: 'desktop-window',
      surface: { entrypoint: 'renderer/index.html', integrity: sri(surfaceHtml) },
      body: { entrypoint: 'renderer/body.html', integrity: bodyIntegrity },
    }) as unknown as DesktopWindowContribution;
  const files = await snapshotPluginSurfaceAssets(pkg, [contribution(sri(livingBodyHtml))]);
  assert.equal(files.get('renderer/body.html')?.toString(), livingBodyHtml);
  await assert.rejects(snapshotPluginSurfaceAssets(pkg, [contribution(sri('another page'))]), /integrity mismatch/);
});

test('the executor forwards the body page only on a livingBody line, beside the surface, and can flush', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f336-body-executor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entrypoint = join(root, 'kernel.mjs');
  const surface = `http://companion-${'c'.repeat(32)}.localhost:4187/packages/fixture/renderer/index.html`;
  const bodyUrl = surface.replace('index.html', 'body.html');
  await writeFile(
    entrypoint,
    `
    import { createInterface } from 'node:readline';
    let opened, flushed = false;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.method === 'open') opened = message.params;
      if (message.method === 'flush-scene') flushed = true;
      const visible = opened?.bodyUrl === ${JSON.stringify(bodyUrl)} && flushed;
      const value = message.method === 'poll' ? (visible ? 'visible' : 'hidden') : null;
      process.stdout.write(JSON.stringify({ v: 1, id: message.id, ok: true, value }) + '\\n');
    });
  `,
  );
  const executor = new ElectronDesktopWindowExecutor({ executable: process.execPath, entrypoint });
  const launch = {
    url: surface,
    presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true },
    publicCompanionV2: true as const,
    signal: new AbortController().signal,
    onClosed() {},
  };
  for (const refused of [
    { companionContract: '0.3.3-candidate.0' as const, bodyUrl },
    { companionContract: LIVING, bodyUrl: surface },
    { companionContract: LIVING, bodyUrl: surface.replace('/renderer/index.html', '/elsewhere/body.html') },
    { companionContract: LIVING, bodyUrl: `http://evil.localhost:4187/packages/fixture/renderer/body.html` },
  ])
    await assert.rejects(executor.open({ ...launch, ...refused }), /invalid desktop (body page|surface origin)/);
  const plain = await executor.open({ ...launch, companionContract: LIVING });
  assert.equal(plain.flushScene, undefined, 'no body page, nothing to flush');
  await plain.close();
  const window = await executor.open({ ...launch, companionContract: LIVING, bodyUrl });
  t.after(() => window.close());
  assert.ok(window.flushScene);
  await window.flushScene();
  assert.equal(await window.poll(), 'visible', 'the kernel got the body page and the flush');
});

const snapshot = { schemaVersion: 1, hat: { askew: true } };
for (const stop of ['disable', 'uninstall', 'shutdown'] as const)
  test(`an API ${stop} flushes the living cat's scene while the bridge is still current, then revokes`, async (t) => {
    const seen: { activation?: string; read?: unknown; write?: unknown }[] = [];
    let f!: Awaited<ReturnType<typeof fixture>>;
    const instance = async () =>
      (await f.runtime.inventoryStore.snapshot()).instances.find((row) => row.pluginInstanceId === f.instanceId);
    f = await fixture(t, '0.1.0-alpha.38', undefined, undefined, async ({ request }) => {
      assert.ok(request);
      // What the kernel does on flush-scene: the body's latest report goes out through the bridge.
      const read = (await request({ kind: 'scene.read' })) as { catId?: string };
      const write = await request({ kind: 'scene.write', catId: read.catId, baseRevision: 0, snapshot });
      seen.push({ activation: (await instance())?.activationState, read, write });
    });
    const before = await instance();
    assert.ok(before);
    if (stop === 'disable') await f.runtime.lifecycle.disable(f.instanceId, before.lifecycleRevision);
    else if (stop === 'uninstall') await f.runtime.lifecycle.uninstall(f.instanceId, before.lifecycleRevision);
    else await f.shutdown();
    const [flush, ...again] = seen;
    assert.ok(flush);
    assert.equal(again.length, 0, 'flushed once, before the stop');
    assert.equal(flush.activation, 'enabled', 'before the lifecycle revoked anything');
    assert.deepEqual(flush.write, { kind: 'scene-put', status: 'ok', revision: 1 }, 'written, not unavailable');
    assert.ok(f.launch.request);
    const late = await f.launch.request({
      kind: 'scene.write',
      catId: 'composition-selected',
      baseRevision: 1,
      snapshot,
    });
    assert.equal((late as { kind: string }).kind, 'error', 'after the stop the bridge is fenced');
  });
