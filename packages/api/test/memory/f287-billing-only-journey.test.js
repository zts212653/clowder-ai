import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { assertBillingPrecedentJourney } from '../helpers/billing-precedent-journey.js';
import { writeOperationalPrecedentFixture } from '../helpers/operational-precedent-fixture.js';

describe('F287 D2 billing-only golden journey', () => {
  test('admitted frame projects the LL-098 fixture with complete whyNow and no free-text search', async (t) => {
    const docsRoot = mkdtempSync(join(tmpdir(), 'billing-precedent-source-'));
    t.after(() => rmSync(docsRoot, { recursive: true, force: true }));
    writeOperationalPrecedentFixture(docsRoot);
    await assertBillingPrecedentJourney({
      docsRoot,
      repoFullName: 'fixture-owner/project',
      expectedSourceText: 'fixture-policy-no-account-action',
    });
  });
});
