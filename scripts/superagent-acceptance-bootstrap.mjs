import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureCoreManagedMcps,
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../packages/api/dist/config/capabilities/capability-orchestrator.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configRoot = join(workspace, 'artifacts/superagent-live/config');
assert.equal(
  resolve(process.env.CAT_CAFE_CONFIG_ROOT ?? ''),
  configRoot,
  'bootstrap is limited to this acceptance configuration',
);
if (!(await readCapabilitiesConfig(configRoot))) {
  const { config } = ensureCoreManagedMcps({ version: 2, capabilities: [] }, { catCafeRepoRoot: workspace });
  await writeCapabilitiesConfig(configRoot, config);
}
