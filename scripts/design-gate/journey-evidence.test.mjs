import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { browserRunnerTestPaths } from './journey-evidence.mjs';
import {
  CLEAN_JOURNEY_BODY,
  expectAccepted,
  expectRejected,
  FIXTURE_JOURNEY_PATH,
  journeyTest,
  productContract,
  withFixtureRepo,
  writeValidIntegratedFixture,
} from './test-fixtures.mjs';

function withValidFixture(run) {
  return withFixtureRepo(({ fixtureRoot, write }) => {
    writeValidIntegratedFixture(write);
    return run({ fixtureRoot, write });
  });
}

describe('default-entry journey binding: every productIntegration claim carries one', () => {
  it('a clean journey registered once, run by test:browser, on a unique surface testid is accepted', () => {
    withValidFixture(({ fixtureRoot }) => {
      expectAccepted(fixtureRoot, productContract());
    });
  });

  it('productIntegration without defaultEntryJourney fails closed', () => {
    withValidFixture(({ fixtureRoot }) => {
      const contract = productContract();
      delete contract.claims.productIntegration.defaultEntryJourney;
      expectRejected(fixtureRoot, contract, /defaultEntryJourney is required/u);
    });
  });

  it('the retired queryNavigation field fails closed instead of being ignored', () => {
    withValidFixture(({ fixtureRoot }) => {
      const contract = productContract();
      contract.claims.productIntegration.queryNavigation = [];
      expectRejected(fixtureRoot, contract, /queryNavigation is retired/u);
    });
  });

  it('journey shape: testPath under packages/web/test/browser, kebab-case journeyId, surfaceTestId', () => {
    withValidFixture(({ fixtureRoot }) => {
      const outside = productContract();
      outside.claims.productIntegration.defaultEntryJourney.testPath = 'packages/web/src/journey.test.mjs';
      expectRejected(fixtureRoot, outside, /must live under packages\/web\/test\/browser\//u);

      const badId = productContract();
      badId.claims.productIntegration.defaultEntryJourney.journeyId = 'Fixture Surface';
      expectRejected(fixtureRoot, badId, /journeyId must be a kebab-case identifier/u);

      const missingTest = productContract();
      missingTest.claims.productIntegration.defaultEntryJourney.testPath =
        'packages/web/test/browser/missing-journey.test.mjs';
      expectRejected(fixtureRoot, missingTest, /testPath does not exist/u);

      const aliasedTest = productContract();
      aliasedTest.claims.productIntegration.defaultEntryJourney.testPath =
        'packages/web/test/browser/./fixture-surface-journey.test.mjs';
      expectRejected(fixtureRoot, aliasedTest, /must use canonical repository path/u);
    });
  });
});

describe('default-entry journey binding: canonical runner', () => {
  it('the journey file must be executed by packages/web test:browser', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        'packages/web/package.json',
        JSON.stringify({ scripts: { 'test:browser': 'node --test test/browser/other.test.mjs' } }),
      );
      expectRejected(fixtureRoot, productContract(), /not run by packages\/web\/package\.json#scripts\.test:browser/u);
    });
  });

  it('api-runner journeys listed as ../web/test/browser/... count as canonical', () => {
    assert.deepEqual(
      browserRunnerTestPaths(
        'node --test test/browser/a.test.mjs && pnpm --filter @cat-cafe/api exec node --import tsx --test ../web/test/browser/b.test.mjs ../api/test/c.test.mjs',
      ),
      ['packages/web/test/browser/a.test.mjs', 'packages/web/test/browser/b.test.mjs'],
    );
    assert.deepEqual(browserRunnerTestPaths(undefined), []);
  });
});

describe('default-entry journey binding: single named registration', () => {
  it('journeyId must be registered exactly once in the bound file', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest(CLEAN_JOURNEY_BODY) + journeyTest(CLEAN_JOURNEY_BODY, { importLine: '' }),
      );
      expectRejected(fixtureRoot, productContract(), /registered exactly once .*\(found 2\)/u);

      write(FIXTURE_JOURNEY_PATH, journeyTest(CLEAN_JOURNEY_BODY, { journeyId: 'other-surface' }));
      expectRejected(fixtureRoot, productContract(), /registered exactly once .*\(found 0\)/u);
    });
  });

  it('the registration must come from the canonical harness module', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write('packages/web/test/browser/my-own-harness.mjs', 'export function registerDefaultEntryJourney() {}\n');
      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest(CLEAN_JOURNEY_BODY, {
          importLine: "import { registerDefaultEntryJourney } from './my-own-harness.mjs';",
        }),
      );
      expectRejected(
        fixtureRoot,
        productContract(),
        /must import registerDefaultEntryJourney from packages\/web\/test\/browser\/default-entry-journey\.harness\.mjs/u,
      );
    });
  });

  it('a local shadow of the registration binding is rejected', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        FIXTURE_JOURNEY_PATH,
        [
          "import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';",
          '{',
          '  const registerDefaultEntryJourney = () => {};',
          "  registerDefaultEntryJourney({ journeyId: 'fixture-surface', surfaceTestId: 'fixture-surface' }, async () => {});",
          '}',
          '',
        ].join('\n'),
      );
      expectRejected(fixtureRoot, productContract(), /binding is shadowed/u);
    });
  });

  it('the registration must assert the same surfaceTestId as the claim', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(FIXTURE_JOURNEY_PATH, journeyTest(CLEAN_JOURNEY_BODY, { surfaceTestId: 'other-surface' }));
      expectRejected(
        fixtureRoot,
        productContract(),
        /asserts surfaceTestId other-surface, claim says fixture-surface/u,
      );
    });
  });
});

describe('default-entry journey binding: the journey walks the product, it does not fabricate it', () => {
  it('setContent / goto / evaluate inside the journey body are rejected', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      const injections = [
        ['  await page.setContent(\'<section data-testid="fixture-surface" />\');', /setContent\(\) at line 4/u],
        ["  await page.goto('http://127.0.0.1:3000/?experienceGate=f290-assembly');", /goto\(\) at line 4/u],
        ["  await page.evaluate(() => { location.search = '?experienceGate=1'; });", /evaluate\(\) at line 4/u],
      ];
      for (const [line, pattern] of injections) {
        write(FIXTURE_JOURNEY_PATH, journeyTest([CLEAN_JOURNEY_BODY[0], line, ...CLEAN_JOURNEY_BODY.slice(1)]));
        expectRejected(fixtureRoot, productContract(), pattern);
      }
    });
  });

  it('storage-only addInitScript and page.route fixtures are allowed', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest([
          '  const context = await browser.newContext();',
          "  await context.addInitScript(() => { window.localStorage.clear(); window.sessionStorage.setItem('seen', '1'); });",
          '  const page = await context.newPage();',
          "  await page.route('**/api/**', (route) => route.fulfill({ status: 200, body: '{}' }));",
          ...CLEAN_JOURNEY_BODY.slice(1),
        ]),
      );
      expectAccepted(fixtureRoot, productContract());
    });
  });

  it('addInitScript that reaches beyond browser storage is rejected', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest(["  await context.addInitScript(() => { document.body.innerHTML = ''; });", ...CLEAN_JOURNEY_BODY]),
      );
      expectRejected(fixtureRoot, productContract(), /addInitScript\(\) at line 3 touches document/u);

      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest([
          "  await context.addInitScript(() => { window['location'].search = ''; });",
          ...CLEAN_JOURNEY_BODY,
        ]),
      );
      expectRejected(fixtureRoot, productContract(), /computed member access/u);
    });
  });
});

describe('default-entry journey binding: the surface testid is unique production source', () => {
  it('accepts a canonical Collective client surface outside the web package', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      const contract = productContract();
      contract.claims.productIntegration.mountChain = [
        { path: 'packages/collective-client/src/Entry.tsx', export: 'Entry' },
        { path: 'packages/collective-client/src/Host.tsx', export: 'Host' },
        { path: 'packages/collective-client/src/Surface.tsx', export: 'Surface' },
      ];
      contract.claims.productIntegration.defaultEntryJourney = {
        testPath: FIXTURE_JOURNEY_PATH,
        journeyId: 'collective-surface',
        surfaceTestId: 'collective-surface',
      };
      write(
        FIXTURE_JOURNEY_PATH,
        journeyTest(CLEAN_JOURNEY_BODY, {
          journeyId: 'collective-surface',
          surfaceTestId: 'collective-surface',
        }),
      );
      write(
        'packages/collective-client/src/Entry.tsx',
        "import { Host } from './Host';\nexport function Entry() { return <Host />; }\n",
      );
      write(
        'packages/collective-client/src/Host.tsx',
        "import { Surface } from './Surface';\nexport function Host() { return <Surface />; }\n",
      );
      write(
        'packages/collective-client/src/Surface.tsx',
        'export function Surface() { return <section data-testid="collective-surface" />; }\n',
      );
      expectAccepted(fixtureRoot, contract);
      write(
        'packages/web/src/CollectiveSurfaceCopy.tsx',
        'export function CollectiveSurfaceCopy() { return <section data-testid="collective-surface" />; }\n',
      );
      expectRejected(fixtureRoot, contract, /not unique.*packages\/web\/src\/CollectiveSurfaceCopy\.tsx/u);
    });
  });

  it('the final surface must carry the testid exactly once', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write(
        'packages/web/src/Surface.tsx',
        "import { ArtifactEditor } from './ArtifactEditor';\nexport function Surface() { return <section><ArtifactEditor /></section>; }\n",
      );
      expectRejected(fixtureRoot, productContract(), /must appear exactly once as data-testid .*\(found 0\)/u);
    });
  });

  it('another product source file carrying the same testid breaks uniqueness', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write('packages/web/src/Copy.tsx', 'export function Copy() { return <div data-testid="fixture-surface" />; }\n');
      expectRejected(
        fixtureRoot,
        productContract(),
        /not unique to the final surface; also in packages\/web\/src\/Copy\.tsx/u,
      );
    });
  });

  it('unit tests under __tests__ or *.test.* do not count against uniqueness', () => {
    withValidFixture(({ fixtureRoot, write }) => {
      write('packages/web/src/__tests__/Surface.test.tsx', 'const id = \'[data-testid="fixture-surface"]\';\n');
      write('packages/web/src/Surface.test.tsx', 'const id = \'[data-testid="fixture-surface"]\';\n');
      expectAccepted(fixtureRoot, productContract());
    });
  });
});
