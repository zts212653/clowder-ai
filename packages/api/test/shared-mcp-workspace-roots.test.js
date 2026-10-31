import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { isPathAllowed } from '../../mcp-server/dist/utils/path-validator.js';
import { prepareSharedMcpLaunch } from '../dist/domains/cats/services/agents/invocation/shared-mcp-launch.js';

for (const transport of ['shared', 'stdio']) {
  test(`${transport} Host roots retain home expansion and workspace-relative configuration`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f333-configured-roots-')));
    const workspace = join(root, 'workspace');
    const nested = join(workspace, 'nested');
    const homeRelativeRoot = `~/${relative(homedir(), root).replaceAll('\\', '/')}`;
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_DATA_DIR', 'ALLOWED_WORKSPACE_DIRS'];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    mkdirSync(join(root, '.cat-cafe'));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
    const document = join(root, 'original-document.txt');
    writeFileSync(document, 'original configured workspace');
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
    process.env.ALLOWED_WORKSPACE_DIRS = ` ~ , ${homeRelativeRoot} , ./nested `;
    try {
      const context = await prepareSharedMcpLaunch({
        catId: 'codex',
        apiUrl: 'http://127.0.0.1:3102',
        workingDirectory: workspace,
        transport,
      });
      assert.deepEqual(context.allowedWorkspaceDirs, [resolve(homedir()), root, nested]);
      const config = { catCafeDir: context.dataDir, allowedDirs: [...context.allowedWorkspaceDirs] };
      assert.equal(isPathAllowed(document, config), true, 'projected roots must still admit their original files');
      assert.equal(isPathAllowed(resolve(homedir(), '..', 'f333-outside-admitted-roots'), config), false);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
