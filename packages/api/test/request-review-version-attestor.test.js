import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { requestReviewAssetVersionRef } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-identity.js';
import { requestReviewSemanticVersion } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-port.js';
import { createRequestReviewVersionAttestor } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-version-attestor.js';

const temporaryRoots = [];

function source(subject) {
  return [
    '---',
    'name: request-review',
    '---',
    `Review-Subject-Ref: ${subject}`,
    'Accepted-Source-Ref: <canonical source>',
    'Accepted-Revision: <exact revision>',
    '',
    'Feature 以 canonical docs/features/F*.md 为 anchor。',
  ].join('\n');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mountedFixture(content) {
  const root = await mkdtemp(join(tmpdir(), 'request-review-attestor-'));
  temporaryRoots.push(root);
  const skillsSource = join(root, 'cat-cafe-skills');
  const packageRoot = join(skillsSource, 'request-review');
  const mountRoot = join(root, '.codex', 'skills');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(mountRoot, { recursive: true });
  await writeFile(join(packageRoot, 'SKILL.md'), content);
  await symlink(packageRoot, join(mountRoot, 'request-review'));
  return { skillsSource, mountRoot };
}

describe('request-review runtime version attestor', () => {
  it('attests the exact semantic and package revisions mounted for the bound invocation', async () => {
    const mountedSource = source('pr:owner/repo#4517');
    const fixture = await mountedFixture(mountedSource);
    const resolvedInvocations = [];
    const attestor = createRequestReviewVersionAttestor({
      async resolveMount(invocationId) {
        resolvedInvocations.push(invocationId);
        return {
          mountRoots: [fixture.mountRoot],
          expectedSkillsRoot: fixture.skillsSource,
        };
      },
    });

    const expected = requestReviewAssetVersionRef(requestReviewSemanticVersion(mountedSource));
    const delivered = await attestor.deliver(expected, 'reviewer-invocation');
    assert.equal(delivered.status, 'attested');
    assert.deepEqual(delivered.deliveredAssetVersionRef, expected);
    assert.match(delivered.deliveredPackageRevision, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(resolvedInvocations, ['reviewer-invocation']);
  });

  it('remains unconfirmed when the selected revision is not the first managed runtime mount', async () => {
    const stale = await mountedFixture(source('pr:owner/repo#old'));
    const expectedSource = source('pr:owner/repo#new');
    const exact = await mountedFixture(expectedSource);
    const attestor = createRequestReviewVersionAttestor({
      async resolveMount() {
        return {
          mountRoots: [stale.mountRoot, exact.mountRoot],
          expectedSkillsRoot: stale.skillsSource,
          fallbackSkillsRoot: exact.skillsSource,
        };
      },
    });

    const result = await attestor.deliver(
      requestReviewAssetVersionRef(requestReviewSemanticVersion(expectedSource)),
      'reviewer-invocation',
    );
    assert.equal(result.status, 'unconfirmed');
    assert.notEqual(result.deliveredAssetVersionRef.version, requestReviewSemanticVersion(expectedSource));
  });
});
