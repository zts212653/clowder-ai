import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These cases exercise first-run bootstrap/healing by the installed Host. A
// linked checkout is read-only by default, so declare ownership of this private
// fixture's binary root rather than relaxing the production publication guard.
/** @param {import('node:test').TestContext} t */
export function useCapabilityWriterFixture(t) {
  const previous = {
    deployment: process.env.CAT_CAFE_DEPLOYMENT_ID,
    runtimeRoot: process.env.CAT_CAFE_RUNTIME_ROOT,
    workspaceRoot: process.env.CAT_CAFE_WORKSPACE_ROOT,
    configRoot: process.env.CAT_CAFE_CONFIG_ROOT,
  };
  const configRoot = mkdtempSync(join(tmpdir(), 'capability-writer-'));
  process.env.CAT_CAFE_CONFIG_ROOT = configRoot;
  process.env.CAT_CAFE_DEPLOYMENT_ID = 'runtime';
  const fixtureRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  process.env.CAT_CAFE_RUNTIME_ROOT = fixtureRoot;
  process.env.CAT_CAFE_WORKSPACE_ROOT = fixtureRoot;
  t.after(() => {
    if (previous.deployment === undefined) delete process.env.CAT_CAFE_DEPLOYMENT_ID;
    else process.env.CAT_CAFE_DEPLOYMENT_ID = previous.deployment;
    if (previous.runtimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
    else process.env.CAT_CAFE_RUNTIME_ROOT = previous.runtimeRoot;
    if (previous.workspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = previous.workspaceRoot;
    if (previous.configRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previous.configRoot;
    rmSync(configRoot, { recursive: true, force: true });
  });
}
