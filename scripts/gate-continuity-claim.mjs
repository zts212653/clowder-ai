#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  createGateContinuityClaim,
  readGateContinuityClaim,
  writeGateContinuityClaim,
} from './lib/gate-continuity-claim.mjs';

const [command, ...args] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
  console.log(
    'Create an explicit gate-owner C2 assertion for one already-integrated cut. This never certifies green or proves machine input closure.',
  );
  console.log(
    'create --run-id ID --base-sha SHA --actor ACTOR --source-ref REF --rationale TEXT --assert-inert-path PATH [...] [-- original gate arguments]',
  );
  console.log('inspect --claim-id HASH');
  console.log(
    'Canonical source checkout only: consume with pnpm gate --continuity-claim HASH, preserving original non-control arguments. Public exports cannot consume claims; exported helpers support inspection and contract tests. See docs/ops/gate-continuity-claims.md.',
  );
  console.log(
    'Create observes live origin/main and requires --base-sha to match it; consumption keeps that frozen cut without fetching.',
  );
  process.exit(0);
}
const separator = args.indexOf('--');
const controls = separator < 0 ? args : args.slice(0, separator);
const options = new Map();
const inertPaths = [];
try {
  for (let index = 0; index < controls.length; index += 2) {
    const key = controls[index],
      value = controls[index + 1];
    if (
      ![
        '--run-id',
        '--base-sha',
        '--actor',
        '--source-ref',
        '--rationale',
        '--assert-inert-path',
        '--claim-id',
      ].includes(key) ||
      !value ||
      (key !== '--assert-inert-path' && options.has(key))
    )
      throw new Error('invalid or duplicate continuity claim argument');
    if (key === '--assert-inert-path') inertPaths.push(value);
    else options.set(key, value);
  }
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim();
  const databasePath =
    process.env.CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH || path.join(commonGit, 'cat-cafe-full-gate-resources.sqlite');
  if (command === 'inspect') {
    console.log(JSON.stringify(readGateContinuityClaim(databasePath, options.get('--claim-id'))));
  } else if (command === 'create') {
    const claim = createGateContinuityClaim({
      repoRoot,
      databasePath,
      runId: options.get('--run-id'),
      baseSha: options.get('--base-sha'),
      assertion: {
        actor: options.get('--actor'),
        sourceRef: options.get('--source-ref'),
        rationale: options.get('--rationale'),
        inertPaths,
      },
      invocationArgs: separator < 0 ? [] : args.slice(separator + 1),
    });
    const claimPath = writeGateContinuityClaim(databasePath, claim);
    console.log(JSON.stringify({ claimHash: claim.claimHash, claimPath, claim }));
  } else
    throw new Error(
      'usage: gate-continuity-claim create --run-id ID --base-sha SHA --actor ACTOR --source-ref REF --rationale TEXT --assert-inert-path PATH [...] [-- original gate arguments]; or inspect --claim-id HASH',
    );
} catch (error) {
  console.error(`[gate-continuity] ${error.message}`);
  process.exitCode = 2;
}
