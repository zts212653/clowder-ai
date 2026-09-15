import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyGateRoute } from '../classify-gate-route.mjs';
import {
  DEFAULT_ENTRY_JOURNEY_HARNESS,
  isDesignGateJourneyPath,
  listDefaultEntryJourneyPaths,
} from './claim-journey-paths.mjs';
import { withFixtureRepo } from './test-fixtures.mjs';

const repoRoot = process.env.DESIGN_GATE_TEST_REPO_ROOT
  ? resolve(process.env.DESIGN_GATE_TEST_REPO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('claim journey paths (gate route classifier input)', () => {
  it('lists the journey files bound by committed claims and skips unreadable contracts', () => {
    withFixtureRepo(({ fixtureRoot, write }) => {
      write(
        'docs/design-gate-claims/a.json',
        JSON.stringify({
          claims: {
            productIntegration: { defaultEntryJourney: { testPath: './packages/web/test/browser/a.test.mjs' } },
          },
        }),
      );
      write('docs/design-gate-claims/nested/b.json', JSON.stringify({ claims: {} }));
      write('docs/design-gate-claims/broken.json', '{ not json');
      assert.deepEqual(listDefaultEntryJourneyPaths(fixtureRoot), ['packages/web/test/browser/a.test.mjs']);
      assert.deepEqual(listDefaultEntryJourneyPaths(fixtureRoot, 'docs/absent'), []);
    });
  });

  it('claims, the harness and bound journeys are design-gate journey paths; other browser tests are not', () => {
    const bound = ['packages/web/test/browser/a.test.mjs'];
    assert.equal(isDesignGateJourneyPath('docs/design-gate-claims/f307.json', bound), true);
    assert.equal(isDesignGateJourneyPath(DEFAULT_ENTRY_JOURNEY_HARNESS, bound), true);
    assert.equal(isDesignGateJourneyPath('packages/web/test/browser/a.test.mjs', bound), true);
    assert.equal(isDesignGateJourneyPath('packages/web/test/browser/b.test.mjs', bound), false);
    assert.equal(isDesignGateJourneyPath('docs/design-gate-claims-notes.md', bound), false);
  });

  it('the committed claims bind the F307 default-entry journey file', () => {
    if (!existsSync(resolve(repoRoot, 'docs/design-gate-claims'))) {
      assert.deepEqual(listDefaultEntryJourneyPaths(repoRoot), []);
      return;
    }
    assert.deepEqual(listDefaultEntryJourneyPaths(repoRoot), [
      'packages/web/test/browser/f307-phase-a-experience-gate.test.mjs',
    ]);
  });
});

describe('gate route: design-gate claims and their bound journeys force the full route', () => {
  const evidence = {
    previousStatus: 'none',
    previousFailureRelevance: 'none',
    authoredPatch: 'changed',
    basePaths: [],
    exactGreen: false,
    journeyEvidencePaths: ['packages/web/test/browser/f307-phase-a-experience-gate.test.mjs'],
  };

  it('a claim contract, the journey harness or a bound journey file cannot stay targeted', () => {
    for (const prPaths of [
      ['docs/design-gate-claims/f307-phase-a-real-shell.json'],
      ['packages/web/test/browser/default-entry-journey.harness.mjs'],
      ['packages/web/test/browser/f307-phase-a-experience-gate.test.mjs'],
    ]) {
      const result = classifyGateRoute({ ...evidence, prPaths });
      assert.equal(result.route, 'full', prPaths.join());
      assert.match(result.reasons.join('\n'), /default-entry browser journeys/u);
    }
  });

  it('an unbound browser test keeps its targeted route', () => {
    const result = classifyGateRoute({
      ...evidence,
      prPaths: ['packages/web/test/browser/f293-team-experience.test.mjs'],
    });
    assert.equal(result.route, 'targeted');
  });
});
