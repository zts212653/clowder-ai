import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { rootCheckChain } from '../lib/root-check-chain.mjs';
import { ROOT } from './context.mjs';

export function buildExportedRootScripts(sourceScripts) {
  const scripts = { ...sourceScripts };
  if (scripts['check:brand-guard']) scripts['check:brand-guard:home'] = scripts['check:brand-guard'];
  scripts['check:brand-guard'] =
    'node --test scripts/public-brand-validation.test.mjs scripts/lib/intake-gh-retry.test.mjs';
  if (
    typeof scripts['check:sources'] === 'string' &&
    !scripts['check:sources'].split(' && ').includes('pnpm check:brand-guard')
  ) {
    scripts['check:sources'] = `pnpm check:brand-guard && ${scripts['check:sources']}`;
  }
  scripts['start:direct'] = 'node ./scripts/start-entry.mjs start:direct --profile=opensource';
  scripts['dev:direct'] = 'node ./scripts/start-entry.mjs dev:direct --profile=opensource';
  scripts['check:start-profile-isolation'] =
    'node --test scripts/start-dev-profile-isolation.test.mjs scripts/start-dev-named-alpha-redis-lease.test.mjs';
  scripts['check:pre-merge-gate'] =
    'node --test scripts/pre-merge-check.test.mjs scripts/pre-merge-gate-guard.test.mjs scripts/pre-merge-gate-guard.alpha.test.mjs scripts/lib/alpha-redis-leases.test.mjs scripts/gate-resource-health-monitor.test.mjs scripts/lib/fseventsd-pressure.test.mjs scripts/lib/clowder-merge-check-evidence.test.mjs scripts/lib/git-patch-id.test.mjs scripts/test-bash-runtime.test.mjs scripts/check-worktree-dirty-ledger.test.mjs scripts/classify-merge-outcome.test.mjs scripts/clowder-merge-execution.test.mjs scripts/lib/gate-continuity-claim.test.mjs scripts/lib/gate-continuity-secret.test.mjs scripts/run-preserving-signal-exit.test.mjs';
  // Mirrors sync-to-opensource.sh: membership looks through the check tiers.
  if (!rootCheckChain(scripts).split(' && ').includes('pnpm check:start-profile-isolation')) {
    scripts.check += ' && pnpm check:start-profile-isolation';
  }
  for (const [name, command] of Object.entries(scripts)) {
    scripts[name] = command
      .split(' && ')
      .filter((segment) => segment !== 'pnpm test:architecture-ownership')
      .join(' && ');
  }
  delete scripts['check:architecture-ownership'];
  delete scripts['test:architecture-ownership'];

  const internalScripts = [
    'check:artifacts:after-api-tests',
    'check:measurement-bundles:after-api-tests',
    'check:capability-tips-enablement:after-api-tests',
    'check:prompt-budget:after-api-tests',
    'check:browser-consumers',
    'sync:train',
    'antigravity:smoke',
    'check:hmac-salt',
    'check:antigravity-smoke',
    'check:incident-containment',
    'check:sync-export',
    'check:web-global-css-imports',
    'check:settings-primitives',
    'check:root-debris',
    'check:source-hygiene',
    'check:f223-action-tracking',
    'check:docs-discovery',
    // Shared-red ownership is backed by the home gate receipt/database control
    // plane. The public repository cannot verify or resolve those identities.
    'gate:shared-red',
    // Memory Architecture Closure reads lane-owned manifests that are not part
    // of the curated public source tree. Must mirror sync-to-opensource.sh.
    'gen:memory-architecture-closure',
    'check:memory-architecture-catalog',
    'gate:memory-architecture-closure',
    // F267 measurement validity audits the complete home evidence archive, which
    // the curated public export intentionally does not contain.
    'check:measurement-bundles',
    // F267 component hashes resolve private home certificate revisions and must
    // be removed from both the exported script table and check:features chain.
    'check:measurement-component-hashes',
    // F251 sibling guard hard-depends on sync-manifest.yaml (not exported). Mirrors the shell list.
    'check:sync-docs-runtime-assets',
    // F238 Phase D: reverse-sanitizer detect-only CLI — internal boundary tooling
    // (PR #2333). Must mirror sync-to-opensource.sh internalScripts list.
    'check:reverse-sanitizer',
    'check:boundary-roundtrip',
    // Outbound boundary guards load scripts/_sanitize-rules.pl, which is internal by
    // construction. Mirrors sync-to-opensource.sh internalScripts.
    'check:outbound-sanitizer',
    // Privacy gate test — references F207 internal incident context; home-only.
    'check:export-privacy-gate',
    // F251 Task 4b — public delta gate test suite (classifier + cli + wire + replay).
    // Home-only sync-pipeline harness; mirrors sync-to-opensource.sh internalScripts.
    'check:sync-public-delta-gate',
    // F251 Task 5 — Public Behavior Change Reporter (KD-11). Home-only sync-pipeline harness.
    'check:public-behavior-impact',
    // F251 AC-A6 — 30-day retroactive eval helper. Home-only, single-shot.
    'check:f251-v1-eval',
    // F247 B1d — home-only cloud-cat supporting service lifecycle helper.
    // References mcp.clowder-ai.com, local Cloudflare tunnel config, and
    // gpt-pro agent-key paths; strip from public package scripts.
    'start:cloud',
    'cloud:status',
    'cloud:doctor',
    'cloud:copy-url',
    'cloud:stop',
    'check:f247-cloud-services',
    // F256 Phase A hook regression tests live in test/hooks/, which is not exported.
    'check:hooks',
    // Prompt-budget guard (#4686 + follow-up): native L0 tokens + builder-prompt chars against
    // the HOME roster; the L0 test and the dossier stay home-only. Mirrors sync-to-opensource.sh.
    'check:prompt-budget',
    // F068 primary-worktree post-checkout guard + local event log are home-only.
    'eval:post-checkout-guard',
    'clean:root-debris',
    'guards:check',
  ];
  for (const scriptName of internalScripts) {
    delete scripts[scriptName];
    for (const [name, command] of Object.entries(scripts)) {
      scripts[name] = command
        .split(' && ')
        .filter((segment) => segment !== `pnpm ${scriptName}` && segment !== `pnpm run ${scriptName}`)
        .join(' && ');
    }
  }
  for (const key of Object.keys(scripts)) {
    if (key.startsWith('desktop:')) delete scripts[key];
  }
  return scripts;
}

export function executePackageScriptsTransform(sourceScripts, marker = 'PACKAGE_JSON_TRANSFORM_EOF') {
  const syncScript = readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf8');
  const startMarker = `<<'${marker}'\n`;
  const start = syncScript.indexOf(startMarker);
  assert.notEqual(start, -1, `public package transform ${marker} start marker must exist`);
  const programStart = start + startMarker.length;
  const end = syncScript.indexOf(`\n${marker}`, programStart);
  assert.notEqual(end, -1, `public package transform ${marker} end marker must exist`);

  const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-public-package-transform-'));
  const packagePath = resolve(tempRoot, 'package.json');
  writeFileSync(packagePath, `${JSON.stringify({ scripts: sourceScripts }, null, 2)}\n`);
  try {
    execFileSync('node', ['-', packagePath], {
      cwd: ROOT,
      encoding: 'utf8',
      input: syncScript.slice(programStart, end),
    });
    return JSON.parse(readFileSync(packagePath, 'utf8')).scripts;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
