import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DevelopmentScopeGitDocuments } from '../../src/domains/growing/DevelopmentScopeGitDocuments.js';

const revision = 'a'.repeat(40);
function documents(files: Record<string, string>) {
  return new DevelopmentScopeGitDocuments('/unused', async (args) => {
    if (args[0] === 'ls-tree') return Object.keys(files).join('\n');
    const file = args[1].slice(revision.length + 1);
    assert.ok(Object.hasOwn(files, file));
    return files[file];
  });
}

test('canonical Feature selection excludes declared support material, independent of filename order', async () => {
  const spec = '---\nfeature_ids: [F310]\ndoc_kind: "spec"\n---\n### Phase B Delivery';
  const result = await documents({
    'docs/features/F310-a-retrospective.md': '---\ndoc_kind: retrospective\n---\n### Phase B Report',
    'docs/features/F310-b-verification.md': '---\ndoc_type: verification\n---\n### Phase B Report',
    'docs/features/F310-c-main.md': spec,
  }).readFeature('F310', revision);
  assert.deepEqual(result, { ref: 'file:docs/features/F310-c-main.md', content: spec });
});

test('support-only or contradictory documents cannot become canonical by being the only filename', async () => {
  for (const metadata of [
    'doc_kind: verification',
    'doc_type: verification',
    'doc_kind: retrospective',
    'doc_kind: audit',
    'doc_kind: callout',
    'doc_kind: spec\ndoc_type: verification',
    'doc_kind: spec\nfeature_ids: [F999]',
    'doc_kind: [spec]',
    'doc_kind: spec\ndoc_kind: retrospective',
  ]) {
    assert.equal(
      await documents({ 'docs/features/F310-report.md': `---\n${metadata}\n---\n### Phase B Report` }).readFeature(
        'F310',
        revision,
      ),
      null,
      metadata,
    );
  }
});

test('two canonical candidates stay ambiguous instead of selecting by title or order', async () => {
  assert.equal(
    await documents({
      'docs/features/F310-first.md': '---\ndoc_kind: spec\n---\n### Phase B First',
      'docs/features/F310-second.md': '---\ndoc_kind: feature-spec\n---\n### Phase B Second',
    }).readFeature('F310', revision),
    null,
  );
});

test('legacy specs without a kind remain supported; prose metadata does not reclassify a spec', async () => {
  for (const content of [
    '# F310\n### Phase B Delivery',
    '---\nfeature_ids: [F310]\n---\n### Phase B Delivery\ndoc_kind: verification',
    '---\ndoc_kind: feature\n---\n### Phase B Delivery',
    '---\ndoc_kind: note\n---\n### Phase B Delivery',
    '---\ndoc_kind: done\n---\n### Phase B Delivery',
    '---\ndoc_kind: vision\n---\n### Phase B Delivery',
  ]) {
    assert.equal(
      (await documents({ 'docs/features/F310-main.md': content }).readFeature('F310', revision))?.content,
      content,
    );
  }
});
