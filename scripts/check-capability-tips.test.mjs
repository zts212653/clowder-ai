import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkCapabilityTipsForRepo } from './check-capability-tips.mjs';

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capability-tips-test-'));
  mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'web', 'src', 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'features', 'F250-test.md'), '# F250 Test\n\n## Tips Contribution\n');
  return root;
}

function writeInventory(root, tips) {
  writeFileSync(
    path.join(root, 'packages', 'web', 'src', 'lib', 'capability-tips.seed.json'),
    JSON.stringify(tips, null, 2),
  );
}

const validTip = {
  id: 'feature-f250-test',
  kind: 'feature',
  sourceRef: {
    path: 'docs/features/F250-test.md',
    anchor: 'F250 Test',
  },
  structureSource: {
    path: 'docs/features/F250-test.md',
    anchor: 'Tips Contribution',
  },
  bodySource: {
    path: 'docs/features/F250-test.md',
    anchor: 'F250 Test',
  },
  contexts: ['feature_dev'],
  audience: ['developer'],
  body: 'F250 有用户可见变化时，要在交付前确认 tips 是否教会用户一个动作。',
  action: {
    type: 'open_concierge_draft',
    label: '了解更多',
  },
  owner: 'codex',
};

describe('F244 capability tips hard check', () => {
  it('passes when a changed feature has a matching sourceRef tip', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [validTip]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, true, result.errors.join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count structureSource or bodySource as changed-file tip coverage', () => {
    const root = makeRepo();
    try {
      writeFileSync(path.join(root, 'docs', 'features', 'F251-other.md'), '# F251 Other\n');
      writeInventory(root, [
        {
          ...validTip,
          id: 'feature-f251-other',
          sourceRef: {
            path: 'docs/features/F251-other.md',
            anchor: 'F251 Other',
          },
          structureSource: {
            path: 'docs/features/F250-test.md',
            anchor: 'Tips Contribution',
          },
          bodySource: {
            path: 'docs/features/F250-test.md',
            anchor: 'F250 Test',
          },
        },
      ]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /missing capability tip or tips_exempt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when a changed feature has neither a matching tip nor tips_exempt', () => {
    const root = makeRepo();
    try {
      writeInventory(root, []);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /missing capability tip or tips_exempt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns (not errors) when changed-file discovery fails (e.g. shallow clone)', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [validTip]);
      const result = checkCapabilityTipsForRepo(root);
      // Changed-file discovery failure is soft: tip validation still runs,
      // only the "new doc needs a tip" coverage check is skipped.
      assert.equal(result.ok, true, 'changed-file failure should not block the gate');
      assert.ok(result.warnings?.length > 0, 'should produce a warning');
      assert.match(result.warnings.join('\n'), /changed-file discovery failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when a changed feature explicitly declares tips_exempt', () => {
    const root = makeRepo();
    try {
      writeFileSync(
        path.join(root, 'docs', 'features', 'F250-test.md'),
        '---\ntips_exempt: internal refactor only\n---\n# F250 Test\n',
      );
      writeInventory(root, []);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, true, result.errors.join('\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat body text mentioning tips_exempt as an exemption', () => {
    const root = makeRepo();
    try {
      writeFileSync(
        path.join(root, 'docs', 'features', 'F250-test.md'),
        '# F250 Test\n\nDocs may explain `tips_exempt: reason`, but this is not an explicit exemption.\n',
      );
      writeInventory(root, []);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /missing capability tip or tips_exempt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns (not errors) when a sourceRef anchor cannot be located', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [
        {
          ...validTip,
          sourceRef: {
            path: 'docs/features/F250-test.md',
            anchor: 'missing anchor',
          },
        },
      ]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      // Anchor-not-found is now a warning (export sanitizer can transform
      // content making source-repo anchors invalid in the export copy).
      assert.equal(result.ok, true, 'anchor-not-found should not block the gate');
      assert.ok(result.warnings?.length > 0, 'should produce a warning');
      assert.match(result.warnings.join('\n'), /anchor not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when enum values are outside the runtime contract', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [
        {
          ...validTip,
          contexts: ['long-running'],
          audience: ['human'],
        },
      ]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /contexts contains unknown value "long-running"/);
      assert.match(result.errors.join('\n'), /audience contains unknown value "human"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when tip id is not a string', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [
        {
          ...validTip,
          id: 123,
        },
      ]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /tip\[0\]: id must be a string/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when action payloads do not match their typed shape', () => {
    const root = makeRepo();
    try {
      writeInventory(root, [
        {
          ...validTip,
          action: {
            type: 'open_guide',
            label: '了解更多',
          },
        },
      ]);
      const result = checkCapabilityTipsForRepo(root, {
        changedFiles: ['docs/features/F250-test.md'],
      });
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), /open_guide action requires guideId/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('documents tips_exempt as feature frontmatter guidance', () => {
    const template = readFileSync(path.resolve('docs/features/TEMPLATE.md'), 'utf8');
    const markdownBlock = template.match(/```markdown\r?\n([\s\S]*?)\r?\n```/)?.[1] ?? '';
    const frontmatter = markdownBlock.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';

    assert.match(frontmatter, /^# tips_exempt: \{reason\}/m);
    assert.doesNotMatch(markdownBlock, /- \[ \] `tips_exempt:` \{reason\}/);
  });
});
