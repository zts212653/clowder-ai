import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { _resetCachedConfig } from '../../dist/config/cat-config-loader.js';
import { reconcileCatRegistry } from '../../dist/config/cat-registry-reconciliation.js';

export const currentMemberId = 'codex61-sol';
export const memberFamilies = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'];

export function memberOwnerFixture(t) {
  assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f333-member-owner-')));
  const runtime = join(root, 'runtime');
  const workspace = join(root, 'workspace');
  const savedEnv = { ...process.env };
  const savedMembers = catRegistry.getAllConfigs();
  for (const path of [runtime, workspace]) {
    mkdirSync(join(path, '.cat-cafe'), { recursive: true });
    writeFileSync(join(path, 'pnpm-workspace.yaml'), 'packages: []\n');
    copyFileSync(resolve('../../cat-template.json'), join(path, 'cat-template.json'));
  }
  const catalog = JSON.parse(readFileSync(join(runtime, 'cat-template.json'), 'utf8'));
  const breed = catalog.breeds.find((entry) => entry.catId === 'codex');
  const member = {
    ...breed.variants[0],
    id: 'fixture-current-sol',
    catId: currentMemberId,
    displayName: 'Current runtime member',
    mentionPatterns: ['@codex61-sol'],
    mcpSupport: true,
    carrier: 'app_server',
  };
  breed.variants.push(member);
  const oldCatalog = JSON.parse(readFileSync(join(workspace, 'cat-template.json'), 'utf8'));
  writeFileSync(join(workspace, '.cat-cafe/cat-catalog.json'), JSON.stringify(oldCatalog));
  writeFileSync(
    join(workspace, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 1,
      capabilities: memberFamilies.map((family) => ({
        id: `cat-cafe-${family}`,
        type: 'mcp',
        source: 'cat-cafe',
        enabled: true,
        mcpServer: { command: process.execPath, args: [join(runtime, 'packages/mcp-server/dist', `${family}.js`)] },
      })),
    }),
  );
  delete process.env.CAT_CAFE_CONFIG_ROOT;
  delete process.env.ALLOWED_WORKSPACE_DIRS;
  Object.assign(process.env, {
    CAT_CAFE_RUNTIME_ROOT: runtime,
    CAT_CAFE_WORKSPACE_ROOT: workspace,
    CAT_TEMPLATE_PATH: join(runtime, 'cat-template.json'),
    CAT_CAFE_MCP_TRANSPORT: 'shared',
    PROJECT_ALLOWED_ROOTS: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: join(root, 'global'),
    AUDIT_LOG_DIR: join(root, 'audit'),
  });
  const refresh = () => {
    writeFileSync(join(runtime, 'cat-template.json'), JSON.stringify(catalog));
    writeFileSync(join(runtime, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
    _resetCachedConfig();
    reconcileCatRegistry(runtime, new Set(catRegistry.getAllIds()));
  };
  refresh();
  t.after(() => {
    process.env = savedEnv;
    _resetCachedConfig();
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedMembers)) catRegistry.register(id, config);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, runtime, workspace, catalog, member, oldCatalog, refresh };
}
