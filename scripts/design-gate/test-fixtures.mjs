import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { checkClaimContract } from '../design-gate-real-interaction.mjs';

export const FIXTURE_JOURNEY_PATH = 'packages/web/test/browser/fixture-surface-journey.test.mjs';
export const FIXTURE_HARNESS_PATH = 'packages/web/test/browser/default-entry-journey.harness.mjs';
export const FIXTURE_RUNNER_SCRIPT =
  'node --test test/browser/other.test.mjs test/browser/fixture-surface-journey.test.mjs';

export function withFixtureRepo(run) {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'design-gate-claim-'));
  const write = (relativePath, content) => {
    const absolutePath = resolve(fixtureRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  };

  try {
    return run({ fixtureRoot, write });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export function validIntegratedContract() {
  return {
    schemaVersion: 1,
    id: 'fixture-integrated-workspace',
    classification: 'product_candidate',
    claims: {
      productIntegration: {
        userEntry: 'Collective → Channel → Artifact',
        mountChain: [
          { path: 'packages/web/src/Entry.tsx', export: 'Entry' },
          { path: 'packages/web/src/Host.tsx', export: 'Host' },
          { path: 'packages/web/src/Surface.tsx', export: 'Surface' },
        ],
        defaultEntryJourney: {
          testPath: FIXTURE_JOURNEY_PATH,
          journeyId: 'fixture-surface',
          surfaceTestId: 'fixture-surface',
        },
      },
      documentEditor: {
        engine: {
          package: '@codemirror/view',
          version: '^6.0.0',
          license: 'MIT',
          source: 'https://codemirror.net/',
        },
        packageManifestPath: 'package.json',
        adapter: { path: 'packages/web/src/ArtifactEditor.tsx', export: 'ArtifactEditor' },
        mount: { path: 'packages/web/src/Surface.tsx', export: 'Surface' },
        contracts: {
          human_edit: ['humanEdit'],
          selection_anchor: ['selectionAnchor'],
          annotation: ['createAnnotation'],
          patch_review: ['reviewPatch'],
          version_undo: ['undoVersion'],
        },
      },
    },
  };
}

// A journey body that only walks the product: enter without query, act, arrive.
export const CLEAN_JOURNEY_BODY = [
  '  const page = await browser.newPage();',
  "  await journey.enter(page, 'http://127.0.0.1:3000/');",
  "  await page.getByTestId('open-surface').click();",
  '  await journey.arrive(page);',
];

export function journeyTest(
  bodyLines,
  { journeyId = 'fixture-surface', surfaceTestId = 'fixture-surface', importLine } = {},
) {
  return [
    importLine ?? "import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';",
    `registerDefaultEntryJourney({ journeyId: '${journeyId}', surfaceTestId: '${surfaceTestId}' }, async (journey) => {`,
    ...bodyLines,
    '});',
    '',
  ].join('\n');
}

export const SURFACE_SOURCE =
  'import { ArtifactEditor } from \'./ArtifactEditor\';\nexport function Surface() { return <section data-testid="fixture-surface"><ArtifactEditor /></section>; }\n';

export function writeValidIntegratedFixture(write) {
  write('package.json', JSON.stringify({ dependencies: { '@codemirror/view': '^6.0.0' } }));
  write('packages/web/package.json', JSON.stringify({ scripts: { 'test:browser': FIXTURE_RUNNER_SCRIPT } }));
  write(FIXTURE_HARNESS_PATH, 'export function registerDefaultEntryJourney() {}\n');
  write(FIXTURE_JOURNEY_PATH, journeyTest(CLEAN_JOURNEY_BODY));
  write('packages/web/src/Entry.tsx', "import { Host } from './Host';\nexport function Entry() { return <Host />; }\n");
  write(
    'packages/web/src/Host.tsx',
    "import { Surface } from './Surface';\nexport function Host() { return <Surface />; }\n",
  );
  write('packages/web/src/Surface.tsx', SURFACE_SOURCE);
  write(
    'packages/web/src/ArtifactEditor.tsx',
    "import { EditorView } from '@codemirror/view';\nconst humanEdit = EditorView.editable;\nconst selectionAnchor = 'selectionAnchor';\nconst createAnnotation = 'createAnnotation';\nconst reviewPatch = 'reviewPatch';\nconst undoVersion = 'undoVersion';\nexport function ArtifactEditor() { return <div data-editor={humanEdit} />; }\n",
  );
}

// Product-integration-only contract (no editor claim).
export function productContract() {
  const contract = validIntegratedContract();
  delete contract.claims.documentEditor;
  return contract;
}

export function expectRejected(fixtureRoot, contract, pattern) {
  const result = checkClaimContract({ repoRoot: fixtureRoot, contract });
  assert.equal(result.ok, false, 'expected the claim to be rejected');
  assert.match(result.errors.join('\n'), pattern);
  return result;
}

export function expectAccepted(fixtureRoot, contract) {
  const result = checkClaimContract({ repoRoot: fixtureRoot, contract });
  assert.equal(result.ok, true, result.errors.join('\n'));
  return result;
}
