import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** No Kimi fixture may read or write the developer's native HOME. */
export function isolateKimiTestEnvironment() {
  const root = mkdtempSync(join(tmpdir(), 'kimi-service-home-'));
  const keys = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'KIMI_CODE_HOME',
    'KIMI_SHARE_DIR',
    'KIMI_CONFIG_FILE',
    'PATH',
    'CAT_CAFE_MCP_SERVER_PATH',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = root;
  for (const key of ['KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_CONFIG_FILE']) delete process.env[key];
  // Tests that need MCP provide their own explicit mcpServerPath. Unrelated
  // cases must not depend on whether this checkout happened to build MCP.
  process.env.CAT_CAFE_MCP_SERVER_PATH = '';
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
}
