import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createAgyAcpPermissionHandler } from '../dist/domains/cats/services/agents/providers/acp/agy/agy-acp-permission.js';
import { resolveDefaultClaudeMcpServerPath } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { buildLiveMcpConfig } from '../dist/domains/concierge/live/live-mcp-config.js';
import { LiveNativeCredentials } from '../dist/domains/concierge/live/live-native-credentials.js';

test('Claude falls back to the declared installation when the project has no readable MCP entry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-installed-mcp-'));
  const project = join(root, 'project');
  const installation = join(root, 'installation');
  const installedEntry = join(installation, 'packages/mcp-server/dist/index.js');
  const projectEntry = join(project, 'packages/mcp-server/dist/index.js');
  const previousRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(installation, 'packages/mcp-server/dist'), { recursive: true });
  writeFileSync(installedEntry, 'export {};');
  process.env.CAT_CAFE_RUNTIME_ROOT = installation;
  assert.equal(resolveDefaultClaudeMcpServerPath(project), installedEntry);

  mkdirSync(join(project, 'packages/mcp-server/dist'), { recursive: true });
  writeFileSync(projectEntry, 'export {};');
  assert.equal(resolveDefaultClaudeMcpServerPath(project), projectEntry, 'readable legacy discovery keeps precedence');
  delete process.env.CAT_CAFE_RUNTIME_ROOT;
  assert.equal(resolveDefaultClaudeMcpServerPath(project), projectEntry);
  rmSync(projectEntry);
  assert.equal(
    resolveDefaultClaudeMcpServerPath(project),
    undefined,
    'no installation is inferred for standalone callers',
  );
});

test('AGY uses its shipped guard in a project without scripts and retains effect denials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-installed-agy-'));
  const previousCwd = process.cwd();
  const profileHome = join(root, 'profile');
  mkdirSync(profileHome);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  const decide = async (target, overrides = {}) => {
    let response;
    await createAgyAcpPermissionHandler({
      sessionId: 'isolated-session',
      workspace: root,
      profileHome,
      autoApprove: true,
      readOnly: false,
      mcpServers: [],
      isActive: () => true,
      ...overrides,
    })(
      {
        params: {
          sessionId: 'isolated-session',
          toolCall: { title: 'write_file', kind: 'edit', rawInput: { FilePath: target } },
          options: [
            { kind: 'allow_once', optionId: 'allow' },
            { kind: 'reject_once', optionId: 'reject' },
          ],
        },
      },
      (value) => {
        response = value;
      },
    );
    return response;
  };
  const ordinary = join(root, 'ordinary.md');
  assert.deepEqual(await decide(ordinary), { optionId: 'allow' });
  assert.deepEqual(await decide(join(profileHome, '.gemini/antigravity-acp/acp_token.json')), { optionId: 'reject' });
  assert.deepEqual(await decide(ordinary, { readOnly: true }), { optionId: 'reject' });
  assert.deepEqual(await decide(ordinary, { autoApprove: false }), { optionId: 'reject' });
  assert.deepEqual(await decide(ordinary, { isActive: () => false }), { optionId: 'reject' });
  assert.deepEqual(await decide(ordinary, { sessionId: 'other-session' }), { optionId: 'reject' });
});

test('Live keeps its active project cwd and docs scope separate from shipped MCP binaries', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cat-cafe-installed-live-'));
  const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_CONFIG_ROOT = project;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
    rmSync(project, { recursive: true, force: true });
  });
  const credentials = await LiveNativeCredentials.create({
    userId: 'owner',
    threadId: 'thread',
    catId: 'codex',
    callId: 'installed-paths',
  });
  t.after(() => credentials.close());
  const mcpDistDir = resolve('../mcp-server/dist');
  const docs = join(project, 'docs');
  const config = await buildLiveMcpConfig({
    credentials,
    mcpDistDir,
    allowedDirectories: [docs],
    callbackEnv: {
      CAT_CAFE_API_URL: 'http://127.0.0.1:1',
      CAT_CAFE_USER_ID: 'owner',
      CAT_CAFE_THREAD_ID: 'thread',
      CAT_CAFE_CAT_ID: 'codex',
      CAT_CAFE_INVOCATION_ID: 'fixture',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
    },
  });
  assert.deepEqual(Object.keys(config.mcp_servers), ['cat-cafe-collab', 'cat-cafe-memory']);
  Object.entries(config.mcp_servers).forEach(([name, server]) => {
    assert.deepEqual(server.args, [join(mcpDistDir, `${name.slice('cat-cafe-'.length)}.js`)]);
    assert.equal(server.cwd, project);
    assert.equal(server.env.ALLOWED_WORKSPACE_DIRS, docs);
  });
  assert.equal(config['features.shell_tool'], false);
  assert.equal(config['features.apply_patch_freeform'], false);
});
