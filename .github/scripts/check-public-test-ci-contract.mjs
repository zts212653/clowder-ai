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

const sharedShardStep = workflow.jobs['public-test-shards'].steps.find(
  (step) => step.name === 'Run shared-resource public-test lane',
);
assert.ok(sharedShardStep, 'the shared-resource public-test shard runner step must exist');
const distributableShardStep = workflow.jobs['public-test-shards'].steps.find(
  (step) => step.name === 'Run distributable public-test lane without external network',
);
assert.ok(distributableShardStep, 'the distributable public-test shard runner step must exist');
const summaryStep = workflow.jobs['public-test-summary'].steps.find(
  (step) => step.name === 'Prove complete public-test coverage and summarize timing',
);
assert.ok(summaryStep, 'the public-test summary step must exist');
assert.deepEqual(
  workflow.jobs['public-test-shards'].strategy.matrix.lane,
  [
    'serial-shared',
    'distributable-1',
    'distributable-2',
    'distributable-3',
    'distributable-4',
    'distributable-5',
    'distributable-6',
  ],
  'public-test CI must retain one explicit shared-resource lane and six guarded distributable shards',
);
assert.deepEqual(
  workflow.jobs['public-test-shards'].permissions,
  { contents: 'read' },
  'public-test shard jobs must not receive repository write permission',
);
const checkoutStep = workflow.jobs['public-test-shards'].steps.find((step) => step.uses === 'actions/checkout@v4');
assert.equal(
  checkoutStep?.with?.['persist-credentials'],
  false,
  'public-test shard jobs must not persist repository credentials',
);
for (const shardStep of [sharedShardStep, distributableShardStep]) {
  assert.equal(
    shardStep.env?.DEFAULT_OWNER_USER_ID,
    'default-user',
    'public tests must use a deterministic local owner identity',
  );
  assert.deepEqual(
    Object.keys(shardStep.env ?? {}).sort(),
    ['DEFAULT_OWNER_USER_ID', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME'],
    'public-test shard execution must not receive external service credentials',
  );
}
assert.equal(
  sharedShardStep.if,
  "matrix.lane == 'serial-shared'",
  'the shared-resource lane must retain network access',
);
assert.equal(
  distributableShardStep.if,
  "matrix.lane != 'serial-shared'",
  'only distributable lanes may enter the no-egress network namespace',
);
assert.match(
  distributableShardStep.run,
  /sudo --preserve-env unshare --net/,
  'distributable public tests must execute in a separate network namespace',
);
assert.match(
  distributableShardStep.run,
  /ip link set lo up/,
  'the distributable network namespace must retain loopback for local test servers',
);
assert.match(
  distributableShardStep.run,
  /setpriv .*--clear-groups/,
  'the distributable test command must drop root after configuring its network namespace',
);
assert.match(
  summaryStep.run,
  /--max-critical-path-ms 600000(?:\s|$)/,
  'public-test evidence must fail when the measured critical path exceeds 10 minutes',
);

process.stdout.write(
  `public-test CI contract OK (Node ${versions[0]}, owner ${distributableShardStep.env.DEFAULT_OWNER_USER_ID})\n`,
);
