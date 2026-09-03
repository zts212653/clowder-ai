import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const runtimeJobs = ['public-test-prepare', 'public-test-shards', 'public-test-summary'];
const versions = runtimeJobs.map((jobName) => {
  const setupNode = workflow.jobs[jobName].steps.find((step) => step.uses === 'actions/setup-node@v4');
  assert.ok(setupNode, `${jobName} must configure Node`);
  return String(setupNode.with['node-version']);
});

for (const [index, version] of versions.entries()) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `${runtimeJobs[index]} must pin an exact Node patch version`);
}
assert.equal(new Set(versions).size, 1, 'plan producers and consumers must use the same Node runtime');

const shardStep = workflow.jobs['public-test-shards'].steps.find((step) => step.name === 'Run public-test lane');
assert.ok(shardStep, 'the public-test shard runner step must exist');
assert.equal(
  shardStep.env?.DEFAULT_OWNER_USER_ID,
  'default-user',
  'public tests must use a deterministic local owner identity',
);

process.stdout.write(
  `public-test CI contract OK (Node ${versions[0]}, owner ${shardStep.env.DEFAULT_OWNER_USER_ID})\n`,
);
