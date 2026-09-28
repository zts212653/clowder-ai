import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDefaultEntryJourney,
  registerDefaultEntryJourney,
} from '../../packages/web/test/browser/default-entry-journey.harness.mjs';

// Runtime semantics of the journey handle, exercised against a fake Playwright page
// so the contract is pinned without launching a browser.

function fakePage({ landOn, surfaceCount = 1 } = {}) {
  const calls = [];
  let current = 'about:blank';
  return {
    calls,
    async goto(url, options) {
      calls.push(['goto', url, options]);
      current = landOn ?? url;
    },
    url() {
      return current;
    },
    getByTestId(testId) {
      calls.push(['getByTestId', testId]);
      return {
        async waitFor(options) {
          calls.push(['waitFor', options]);
        },
        async count() {
          return surfaceCount;
        },
      };
    },
  };
}

const ids = { journeyId: 'fixture-surface', surfaceTestId: 'fixture-surface' };

function runtimeFixture(testSource, run) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'default-entry-runtime-'));
  const browserDirectory = join(repoRoot, 'packages/web/test/browser');
  const claimsDirectory = join(repoRoot, 'docs/design-gate-claims');
  mkdirSync(browserDirectory, { recursive: true });
  mkdirSync(claimsDirectory, { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../../packages/web/test/browser/default-entry-journey.harness.mjs', import.meta.url)),
    join(browserDirectory, 'default-entry-journey.harness.mjs'),
  );
  const testPath = join(browserDirectory, 'claimed-journey.test.mjs');
  writeFileSync(testPath, testSource);
  writeFileSync(
    join(claimsDirectory, 'fixture.json'),
    JSON.stringify({
      claims: {
        productIntegration: {
          defaultEntryJourney: {
            testPath: 'packages/web/test/browser/claimed-journey.test.mjs',
            journeyId: 'claimed-journey',
            surfaceTestId: 'claimed-surface',
          },
        },
      },
    }),
  );
  try {
    return run(testPath);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('default-entry journey runtime', () => {
  it('enter rejects a query string or fragment before navigating', async () => {
    const page = fakePage();
    await assert.rejects(
      createDefaultEntryJourney(ids).enter(page, 'http://127.0.0.1:3000/?experienceGate=f290-assembly'),
      /must not carry a query string/u,
    );
    await assert.rejects(
      createDefaultEntryJourney(ids).enter(page, 'http://127.0.0.1:3000/#candidate'),
      /must not carry a fragment/u,
    );
    assert.deepEqual(page.calls, []);
  });

  it('enter rejects an app that redirects its default entry into a query-gated state', async () => {
    const page = fakePage({ landOn: 'http://127.0.0.1:3000/?mode=candidate' });
    await assert.rejects(
      createDefaultEntryJourney(ids).enter(page, 'http://127.0.0.1:3000/'),
      /must not redirect its default entry/u,
    );
  });

  it('arrive needs enter first, on the same page, with exactly one surface on screen', async () => {
    const page = fakePage();
    await assert.rejects(createDefaultEntryJourney(ids).arrive(page), /needs enter\(\) first/u);

    const journey = createDefaultEntryJourney(ids);
    await journey.enter(page, 'http://127.0.0.1:3000/');
    await assert.rejects(journey.arrive(fakePage()), /arrival must happen on the entered page/u);

    const crowded = fakePage({ surfaceCount: 2 });
    const crowdedJourney = createDefaultEntryJourney(ids);
    await crowdedJourney.enter(crowded, 'http://127.0.0.1:3000/');
    await assert.rejects(crowdedJourney.arrive(crowded), /exactly one fixture-surface surface/u);
  });

  it('completion requires both enter and arrive, in that order', async () => {
    const page = fakePage();
    const journey = createDefaultEntryJourney(ids);
    assert.throws(() => journey.assertCompleted(), /never entered/u);
    await journey.enter(page, 'http://127.0.0.1:3000/');
    assert.throws(() => journey.assertCompleted(), /never arrived/u);
    await assert.rejects(journey.enter(page, 'http://127.0.0.1:3000/'), /runs once per journey/u);
    await journey.arrive(page);
    journey.assertCompleted();
    assert.deepEqual(page.calls[0], ['goto', 'http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' }]);
    assert.deepEqual(page.calls.slice(1), [
      ['getByTestId', 'fixture-surface'],
      ['waitFor', { state: 'visible' }],
    ]);
  });

  it('journeyId must be a kebab-case identifier', () => {
    assert.throws(() => createDefaultEntryJourney({ journeyId: 'Fixture Surface', surfaceTestId: 'x' }), /kebab-case/u);
    assert.throws(() => createDefaultEntryJourney({ journeyId: 'fixture', surfaceTestId: ' ' }), /surfaceTestId/u);
  });

  it('fails the test process when a claimed registration exists only in an unexecuted branch', () => {
    runtimeFixture(
      [
        "import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';",
        'if (false) {',
        "  registerDefaultEntryJourney({ journeyId: 'claimed-journey', surfaceTestId: 'claimed-surface' }, async () => {});",
        '}',
      ].join('\n'),
      (testPath) => {
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', testPath], {
          encoding: 'utf8',
          env: childEnvironment,
        });
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(`${result.stdout}\n${result.stderr}`, /claimed-journey.*never registered/u);
      },
    );
  });

  it('accepts the process only after the exact claimed journey completes', () => {
    runtimeFixture(
      [
        "import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';",
        'const page = {',
        "  current: 'about:blank',",
        '  async goto(url) { this.current = url; },',
        '  url() { return this.current; },',
        '  getByTestId() { return { async waitFor() {}, async count() { return 1; } }; },',
        '};',
        "registerDefaultEntryJourney({ journeyId: 'claimed-journey', surfaceTestId: 'claimed-surface' }, async (journey) => {",
        "  await journey.enter(page, 'http://127.0.0.1:3000/');",
        '  await journey.arrive(page);',
        '});',
      ].join('\n'),
      (testPath) => {
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', testPath], {
          encoding: 'utf8',
          env: childEnvironment,
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      },
    );
  });

  it('fails the process when runtime options override the claimed surface tuple', () => {
    runtimeFixture(
      [
        "import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';",
        "const options = { surfaceTestId: 'other-surface' };",
        "const page = { current: 'about:blank', async goto(url) { this.current = url; },",
        '  url() { return this.current; },',
        "  getByTestId(id) { return { async waitFor() {}, async count() { return id === 'other-surface' ? 1 : 0; } }; },",
        '};',
        "registerDefaultEntryJourney({ journeyId: 'claimed-journey', surfaceTestId: 'claimed-surface', ...options }, async (journey) => {",
        "  await journey.enter(page, 'http://127.0.0.1:3000/');",
        '  await journey.arrive(page);',
        '});',
      ].join('\n'),
      (testPath) => {
        const childEnvironment = { ...process.env };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', testPath], {
          encoding: 'utf8',
          env: childEnvironment,
        });
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(`${result.stdout}\n${result.stderr}`, /claimed-journey.*claimed-surface.*never registered/u);
      },
    );
  });
});

registerDefaultEntryJourney(
  { ...ids, title: 'the wrapper runs enter and arrive and checks completion' },
  async (journey) => {
    const page = fakePage();
    await journey.enter(page, 'http://127.0.0.1:3000/');
    await journey.arrive(page);
  },
);
