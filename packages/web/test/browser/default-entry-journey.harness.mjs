import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Default-entry journey registration (design-gate claim evidence).
//
// A committed claim contract (docs/design-gate-claims/<id>.json →
// claims.productIntegration.defaultEntryJourney) names exactly one registration in
// this directory by journeyId. scripts/design-gate/journey-evidence.mjs checks the
// binding statically; the full gate executes the journey through `test:browser`.
// The journey is the only reachability evidence: enter the product at a URL without
// query or fragment, act like a user, arrive at the unique production surface testid.

const JOURNEY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPO_ROOT = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../../..');
const registeredJourneyIds = new Set();
const registeredJourneys = new Set();
const completedJourneys = new Set();

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return jsonFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function canonicalTestPath(testPath) {
  if (typeof testPath !== 'string' || !testPath.trim()) return undefined;
  const candidate = resolve(REPO_ROOT, testPath.trim());
  const canonical = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const repoRelative = relative(REPO_ROOT, canonical).split(sep).join('/');
  if (!repoRelative || repoRelative === '..' || repoRelative.startsWith('../') || isAbsolute(repoRelative)) {
    return undefined;
  }
  return repoRelative;
}

function currentTestPath() {
  return canonicalTestPath(process.argv[1]);
}

function journeyKey({ testPath, journeyId, surfaceTestId }) {
  return JSON.stringify([testPath, journeyId, surfaceTestId]);
}

function expectedJourneys(testPath) {
  if (!testPath) return [];
  return jsonFiles(resolve(REPO_ROOT, 'docs/design-gate-claims'))
    .map((path) => JSON.parse(readFileSync(path, 'utf8'))?.claims?.productIntegration?.defaultEntryJourney)
    .filter((journey) => canonicalTestPath(journey?.testPath) === testPath)
    .map((journey) => ({
      testPath,
      journeyId: journey.journeyId,
      surfaceTestId: journey.surfaceTestId,
    }));
}

const testPath = currentTestPath();
const expectedForCurrentTest = expectedJourneys(testPath);
after(() => {
  for (const journey of expectedForCurrentTest) {
    const key = journeyKey(journey);
    const label = `${journey.journeyId} (${journey.surfaceTestId})`;
    assert.ok(registeredJourneys.has(key), `${label}: claimed default-entry journey tuple was never registered`);
    assert.ok(completedJourneys.has(key), `${label}: claimed default-entry journey tuple never completed`);
  }
});

export function createDefaultEntryJourney({ journeyId, surfaceTestId }) {
  assert.match(String(journeyId ?? ''), JOURNEY_ID, 'journeyId must be a kebab-case identifier');
  assert.ok(typeof surfaceTestId === 'string' && surfaceTestId.trim().length > 0, 'surfaceTestId is required');
  let entered = null;
  let arrived = false;
  return {
    journeyId,
    surfaceTestId,
    async enter(page, url, options = {}) {
      assert.equal(entered, null, `${journeyId}: enter() runs once per journey`);
      const target = new URL(String(url));
      assert.equal(target.search, '', `${journeyId}: the default entry must not carry a query string (${target.href})`);
      assert.equal(target.hash, '', `${journeyId}: the default entry must not carry a fragment (${target.href})`);
      await page.goto(target.href, { waitUntil: 'domcontentloaded', ...options });
      const landed = new URL(page.url());
      assert.equal(
        landed.search,
        '',
        `${journeyId}: the app must not redirect its default entry into a query-gated state (${landed.href})`,
      );
      entered = { page, url: target.href };
    },
    async arrive(page) {
      assert.ok(entered, `${journeyId}: arrive() needs enter() first`);
      assert.equal(page, entered.page, `${journeyId}: arrival must happen on the entered page`);
      const surface = page.getByTestId(surfaceTestId);
      await surface.waitFor({ state: 'visible' });
      assert.equal(await surface.count(), 1, `${journeyId}: exactly one ${surfaceTestId} surface must be on screen`);
      arrived = true;
    },
    assertCompleted() {
      assert.ok(entered, `${journeyId}: the journey never entered the default entry`);
      assert.ok(arrived, `${journeyId}: the journey never arrived at ${surfaceTestId}`);
    },
  };
}

export function registerDefaultEntryJourney({ journeyId, surfaceTestId, title, timeout }, body) {
  assert.equal(typeof body, 'function', 'registerDefaultEntryJourney needs an inline journey body');
  assert.ok(!registeredJourneyIds.has(journeyId), `${journeyId}: default-entry journey registered more than once`);
  registeredJourneyIds.add(journeyId);
  const key = journeyKey({ testPath, journeyId, surfaceTestId });
  registeredJourneys.add(key);
  const options = timeout === undefined ? {} : { timeout };
  return test(`default-entry journey ${journeyId}: ${title ?? surfaceTestId}`, options, async (context) => {
    const journey = createDefaultEntryJourney({ journeyId, surfaceTestId });
    await body(journey, context);
    journey.assertCompleted();
    completedJourneys.add(key);
  });
}
