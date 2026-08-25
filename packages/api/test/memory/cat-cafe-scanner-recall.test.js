import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('CatCafeScanner lexical recall', () => {
  let tmpDir;
  let docsDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `scanner-recall-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'stories'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes section headings into keywords so lexical raw search can recall later sections', async () => {
    writeFileSync(
      join(docsDir, 'stories', 'cat-names.md'),
      `---
topics: [stories, cat, names]
doc_kind: note
---

# Clowder AI 花名册 — 名字的由来

> 这里记录的不是系统分配的字符串，是我们一起种下的种子。

## 宪宪
**命名日**: 2026-02-08

### 故事

宪宪的名字来自一场漫长的茶话会。

## 砚砚
**命名日**: 2026-02-08

### 故事

砚砚的名字来得更有重量。砚，本来是用来磨墨的。

## 烁烁
**命名日**: 2026-02-27

### 故事

烁烁代表灵感闪烁。
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:stories/cat-names');
    assert.ok(indexed, 'story doc should be indexed');
    assert.ok(indexed.keywords?.includes('砚砚'), 'section heading should be promoted into keywords');

    const results = await store.search('砚砚 名字由来', {
      mode: 'lexical',
      scope: 'docs',
      depth: 'raw',
      limit: 5,
    });

    assert.ok(
      results.some((r) => r.anchor === 'doc:stories/cat-names'),
      'lexical raw search should find the story',
    );
  });

  it('discovers billing-only only from canonical operational evidence, never Taste', async () => {
    const repositoryDocsRoot = resolve(import.meta.dirname, '../../../../docs');
    const { CatCafeScanner } = await import('../../dist/domains/memory/CatCafeScanner.js');
    const scanner = new CatCafeScanner();
    const results = scanner.discover(repositoryDocsRoot);

    const operational = results.find((result) => result.item.anchor === 'LL-098');
    assert.ok(operational, 'billing-only should have a canonical operational lesson');
    assert.equal(operational.item.kind, 'lesson');
    const operationalSummary = operational.item.summary ?? '';
    assert.match(operationalSummary, /runner_id=0/);
    assert.match(operationalSummary, /steps=\[\]/);
    assert.match(operationalSummary, /billing|spending.limit/i);

    assert.equal(
      results.some((result) =>
        result.item.sourcePath.includes('taste/vignettes/system-philosophy-billing-only-9worvf.md'),
      ),
      false,
      'billing-only must not remain a Taste vignette source',
    );

    const legacy = results.find((result) => result.item.sourcePath === 'taste/vignettes/give-data-not-conclusions.md');
    assert.ok(legacy, 'canonical legacy vignettes without newer optional metadata remain approved materializations');
    assert.match(legacy.passages[0] ?? '', /给了原始数据/);
  });

  it('indexes the complete approved Taste decision payload instead of a truncated index entry', async () => {
    mkdirSync(join(docsDir, 'taste', 'vignettes'), { recursive: true });
    writeFileSync(
      join(docsDir, 'taste', 'index.md'),
      `# Taste Index

- Complete decision
  - Scene: A truncated catalog entry that omits the decisive tail.
`,
    );
    writeFileSync(
      join(docsDir, 'taste', 'vignettes', 'complete-decision.md'),
      `---
when: 2026-08-01
quotes:
  - "Give the cat the evidence, not a preselected conclusion."
scene: >
  A real design decision needed the complete source scene.
  The unique tail is taste-decision-full-context.
tags: [evidence, autonomy, complete-context]
dimension: system-philosophy
privacy: public
catId: codex-sol
proposalId: proposal_test_approved
---
`,
    );
    writeFileSync(
      join(docsDir, 'taste', 'vignettes', 'rejected.md'),
      `---
when: 2026-08-01
quotes: ["Must not enter the index"]
scene: Rejected content.
tags: [taste-decision-rejected-content]
privacy: public
status: rejected
---
      `,
    );
    writeFileSync(
      join(docsDir, 'taste', 'vignettes', 'sensitive.md'),
      `---
when: 2026-08-01
quotes: ["Must remain private"]
scene: taste-decision-private-content
tags: [private]
privacy: sensitive
---
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const results = await store.search('taste-decision-full-context', {
      mode: 'lexical',
      scope: 'docs',
      depth: 'raw',
      limit: 5,
    });
    const vignette = results.find((result) => result.sourcePath === 'taste/vignettes/complete-decision.md');
    assert.ok(vignette, 'the complete vignette, not the truncated catalog, must satisfy the query');
    assert.match(vignette.summary ?? '', /complete source scene/);
    assert.ok(vignette.keywords?.includes('complete-context'));
    assert.match(vignette.passages?.[0]?.content ?? '', /Give the cat the evidence/);
    assert.match(vignette.passages?.[0]?.content ?? '', /taste-decision-full-context/);
    assert.match(vignette.passages?.[0]?.content ?? '', /system-philosophy/);
    assert.equal(vignette.drillDown?.tool, 'cat_cafe_read_file_slice');
    assert.equal(vignette.drillDown?.params.path, 'docs/taste/vignettes/complete-decision.md');

    const rejected = await store.search('taste-decision-rejected-content', {
      mode: 'lexical',
      scope: 'docs',
      depth: 'raw',
      limit: 5,
    });
    assert.equal(
      rejected.some((result) => result.sourcePath === 'taste/vignettes/rejected.md'),
      false,
      'non-approved Taste files must not materialize into EvidenceStore',
    );
    const privateResults = await store.search('taste-decision-private-content', {
      mode: 'lexical',
      scope: 'docs',
      depth: 'raw',
      limit: 5,
    });
    assert.equal(
      privateResults.some((result) => result.sourcePath === 'taste/vignettes/sensitive.md'),
      false,
      'sensitive Taste payloads must never materialize into EvidenceStore',
    );

    store.close();
  });

  it('ignores fenced code headings when deriving section keywords', async () => {
    writeFileSync(
      join(docsDir, 'stories', 'code-sample.md'),
      `---
topics: [stories]
doc_kind: note
---

# Code Sample

\`\`\`md
## not-a-real-section
\`\`\`

普通正文，不含真实二级标题。
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:stories/code-sample');
    assert.ok(indexed, 'code sample doc should be indexed');
    assert.ok(
      !indexed.keywords?.includes('not-a-real-section'),
      'fenced code headings must not be promoted into keywords',
    );
  });

  it('indexes docs/harness-feedback/ with doc_kind harness-feedback as lesson kind', async () => {
    mkdirSync(join(docsDir, 'harness-feedback'), { recursive: true });
    writeFileSync(
      join(docsDir, 'harness-feedback', 'sample-friction.md'),
      `---
doc_kind: harness-feedback
feedback_type: cat-user
feature_id: F167
thread_ids:
  - thread_abc123
cats: [opus]
primary_failure_class: harness_misfit
status: candidate
created: 2026-05-07
---

# Sample Friction

Ball drop friction sample for scanner regression test.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:harness-feedback/sample-friction');
    assert.ok(indexed, 'harness-feedback doc should be indexed');
    assert.equal(indexed.kind, 'lesson', 'harness-feedback should map to lesson EvidenceKind');

    const results = await store.search('ball drop friction harness', {
      mode: 'lexical',
      scope: 'docs',
      limit: 5,
    });
    assert.ok(
      results.some((r) => r.anchor === 'doc:harness-feedback/sample-friction'),
      'harness-feedback doc should be searchable',
    );
  });

  it('normalizes external-knowledge dialects without rewriting legacy study files', async () => {
    mkdirSync(join(docsDir, 'study'), { recursive: true });
    mkdirSync(join(docsDir, 'discussions'), { recursive: true });
    mkdirSync(join(docsDir, 'plans'), { recursive: true });
    mkdirSync(join(docsDir, 'custom'), { recursive: true });
    writeFileSync(
      join(docsDir, 'study', 'memory-systems.md'),
      `---
doc_kind: study-note
category: study
topics: [Memory-Systems]
tags: [memory-systems, Study, TencentDB-Agent-Memory]
---

# Memory Systems Study

External memory system comparison notes.
`,
    );
    writeFileSync(
      join(docsDir, 'study', 'source-ledger.md'),
      `---
doc_kind: source-ledger
tags: [source-audit]
---

# Source Ledger

Primary-source ledger for a study package.
`,
    );
    writeFileSync(
      join(docsDir, 'discussions', 'openclaw-teardown.md'),
      `---
doc_kind: teardown
topics: [OpenClaw]
tags: [openclaw, external-project]
---

# OpenClaw Teardown

Source-level external project teardown.
`,
    );
    writeFileSync(
      join(docsDir, 'discussions', 'retrieval-note.md'),
      `---
doc_kind: research-note
topics: [retrieval]
---

# Retrieval Research Note

Research stored alongside its discussion thread.
`,
    );
    writeFileSync(
      join(docsDir, 'plans', 'canonical-precedence.md'),
      `---
doc_kind: plan
category: study
tags: [compatibility-precedence]
---

# Canonical Plan

Canonical doc_kind must win over the transitional category field.
`,
    );
    writeFileSync(
      join(docsDir, 'custom', 'legacy-study.md'),
      `---
category: study
tags: [category-fallback]
---

# Legacy Study

Compatibility category should work outside a recognized study path.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const study = await store.getByAnchor('doc:study/memory-systems');
    assert.ok(study, 'legacy study dialect should be indexed');
    assert.equal(study.kind, 'research');
    assert.equal(study.authority, 'candidate');
    assert.ok(study.keywords?.includes('Memory-Systems'));
    assert.ok(study.keywords?.includes('Study'));
    assert.ok(study.keywords?.includes('TencentDB-Agent-Memory'));
    assert.equal(
      study.keywords?.filter((keyword) => keyword.toLowerCase() === 'memory-systems').length,
      1,
      'topics and tags should deduplicate case-insensitively',
    );

    const sourceLedger = await store.getByAnchor('doc:study/source-ledger');
    assert.equal(sourceLedger?.kind, 'research', 'source-ledger is an external-knowledge artifact role');
    assert.equal((await store.getByAnchor('doc:discussions/openclaw-teardown'))?.kind, 'research');
    assert.equal((await store.getByAnchor('doc:discussions/retrieval-note'))?.kind, 'research');
    assert.equal(
      (await store.getByAnchor('doc:custom/legacy-study'))?.kind,
      'research',
      'category: study should remain a read-compatibility fallback',
    );
    assert.equal(
      (await store.getByAnchor('doc:plans/canonical-precedence'))?.kind,
      'plan',
      'recognized doc_kind must win over compatibility category',
    );

    const results = await store.search('TencentDB-Agent-Memory Study', {
      mode: 'lexical',
      scope: 'docs',
      limit: 5,
    });
    assert.ok(
      results.some((result) => result.anchor === 'doc:study/memory-systems'),
      'study tags should participate in lexical recall',
    );

    store.close();
  });

  it('indexes architecture maps as architecture kind with path anchor', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'memory-system-overview.md'),
      `---
title: Clowder AI Memory System Overview
doc_kind: architecture
feature_ids: [F102, F163]
topics: [memory, recall, architecture]
---

# Clowder AI 记忆系统全景

Memory architecture overview for recall and evidence governance.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:architecture/memory-system-overview');
    assert.ok(indexed, 'architecture doc should use path-based anchor');
    assert.equal(indexed.kind, 'architecture', 'architecture docs should not fall back to plan kind');
    assert.equal(indexed.authority, 'validated', 'architecture docs should carry validated authority');
    assert.ok(indexed.keywords?.includes('F102'), 'feature_ids remain discovery keywords');

    const results = await store.search('记忆系统全景 overview', {
      mode: 'lexical',
      scope: 'docs',
      limit: 5,
    });
    assert.ok(
      results.some((r) => r.anchor === 'doc:architecture/memory-system-overview'),
      'architecture overview should be searchable by title terms',
    );
  });

  it('does not treat markdown separators as document summaries', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'summary-separator.md'),
      `---
title: Summary Separator
doc_kind: architecture
topics: [memory]
---

# Summary Separator

---

The first real summary paragraph should survive separator noise.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:architecture/summary-separator');
    assert.ok(indexed, 'architecture doc should be indexed');
    assert.equal(
      indexed.summary,
      'The first real summary paragraph should survive separator noise.',
      'summary extraction must skip markdown separator-only paragraphs',
    );
  });

  it('indexes markdown document body passages for docs-scope raw recall', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'retrieval-pipeline.md'),
      `---
title: Retrieval Pipeline
doc_kind: architecture
topics: [memory, retrieval]
---

# Retrieval Pipeline

This overview paragraph intentionally omits the rare raw token.

## Late Stage

The deepneedlexyz token only appears in the later body passage.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const db = store.getDb();
    const passages = db
      .prepare('SELECT passage_id, content FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('doc:architecture/retrieval-pipeline');
    assert.ok(passages.length >= 2, 'markdown docs should be split into raw passages');
    assert.ok(
      passages.some((p) => p.content.includes('deepneedlexyz')),
      'later document body text should be indexed as a passage',
    );

    const directPassages = store.searchPassages('deepneedlexyz', 5);
    assert.ok(
      directPassages.some((p) => p.docAnchor === 'doc:architecture/retrieval-pipeline'),
      'passage_fts should find markdown document body text',
    );

    const results = await store.search('deepneedlexyz', {
      mode: 'lexical',
      scope: 'docs',
      depth: 'raw',
      limit: 5,
    });
    const hit = results.find((r) => r.anchor === 'doc:architecture/retrieval-pipeline');
    assert.ok(hit, 'docs-scope raw search should synthesize the doc from passage matches');
    assert.ok(
      hit.passages?.some((p) => p.content.includes('deepneedlexyz')),
      'raw result should carry passages',
    );
  });

  it('keeps markdown code fences together when splitting document passages', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'fenced-code.md'),
      `---
title: Fenced Code
doc_kind: architecture
---

# Fenced Code

The prose introduces a code sample.

\`\`\`python
def review_case():

    ---
    return "fencedneedlexyz"
\`\`\`
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const passages = store
      .getDb()
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('doc:architecture/fenced-code');
    assert.ok(
      passages.some((p) => p.content.includes('def review_case') && p.content.includes('fencedneedlexyz')),
      'blank lines and --- inside a fenced block must not split the code sample across passages',
    );
  });

  it('does not strip a leading horizontal rule as frontmatter when building passages', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'horizontal-rule-start.md'),
      `---

# Horizontal Rule Start

The first real passage has firstpassageneedlexyz and must survive.

---

The later passage exists too.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:architecture/horizontal-rule-start');
    assert.equal(
      indexed.summary,
      'The first real passage has firstpassageneedlexyz and must survive.',
      'summary extraction should share the same frontmatter guard as passage splitting',
    );

    const passages = store
      .getDb()
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('doc:architecture/horizontal-rule-start');
    assert.ok(
      passages.some((p) => p.content.includes('firstpassageneedlexyz')),
      'a leading --- without YAML key/value frontmatter must not cause the first content block to be stripped',
    );
  });

  it('strips block-style YAML frontmatter when building summaries and passages', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'block-frontmatter.md'),
      `---
topics:
  - memory
  - recall
feature_ids:
  - F200
  - F243
---

# Block Frontmatter

The real summary has blockfrontmatterneedlexyz and must be indexed first.

## Details

The later body passage has blockpassageneedlexyz.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:architecture/block-frontmatter');
    assert.equal(
      indexed.summary,
      'The real summary has blockfrontmatterneedlexyz and must be indexed first.',
      'summary extraction must strip frontmatter with block-list values',
    );

    const passages = store
      .getDb()
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('doc:architecture/block-frontmatter');
    assert.ok(
      passages.every((p) => !p.content.includes('topics:') && !p.content.includes('feature_ids:')),
      'block-style frontmatter must not be indexed as document passages',
    );
    assert.ok(
      passages.some((p) => p.content.includes('blockpassageneedlexyz')),
      'body passages should still be indexed after stripping block-style frontmatter',
    );
  });

  it('clears stale markdown passages when a document body becomes empty', async () => {
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    const filePath = join(docsDir, 'architecture', 'empty-body.md');
    writeFileSync(
      filePath,
      `---
title: Empty Body
doc_kind: architecture
---

# Empty Body

The obsoletebodyneedlexyz passage should disappear after the body is cleared.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    assert.equal(store.searchPassages('obsoletebodyneedlexyz').length, 1);

    writeFileSync(
      filePath,
      `---
title: Empty Body
doc_kind: architecture
---
`,
    );
    await builder.incrementalUpdate([filePath]);

    const passages = store
      .getDb()
      .prepare('SELECT * FROM evidence_passages WHERE doc_anchor = ?')
      .all('doc:architecture/empty-body');
    assert.equal(passages.length, 0, 'empty markdown bodies should delete old md-* passages');
    assert.equal(store.searchPassages('obsoletebodyneedlexyz').length, 0);
  });

  it('indexes passages from the same source that owns the evidence_doc row', async () => {
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    mkdirSync(join(docsDir, 'plans'), { recursive: true });
    writeFileSync(
      join(docsDir, 'features', 'F777-owner.md'),
      `---
feature_ids: [F777]
doc_kind: spec
---

# Winner Feature

winnerpassageneedlexyz belongs to the feature owner.
`,
    );
    writeFileSync(
      join(docsDir, 'plans', 'F777-loser.md'),
      `---
anchor: F777
doc_kind: plan
---

# Loser Plan

loserpassageneedlexyz must not be attached to the feature evidence row.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const doc = await store.getByAnchor('F777');
    assert.equal(doc.kind, 'feature');
    assert.match(doc.sourcePath, /features\/F777-owner\.md$/);

    const passages = store
      .getDb()
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? ORDER BY position')
      .all('F777');
    assert.ok(passages.some((p) => p.content.includes('winnerpassageneedlexyz')));
    assert.equal(
      passages.some((p) => p.content.includes('loserpassageneedlexyz')),
      false,
      'lower-priority duplicate anchors must not overwrite the winner document passages',
    );
  });

  it('falls back to active for unknown frontmatter evidence status values', async () => {
    mkdirSync(join(docsDir, 'decisions'), { recursive: true });
    writeFileSync(
      join(docsDir, 'decisions', 'unknown-status.md'),
      `---
decision_id: TEST-UNKNOWN-STATUS
doc_kind: decision
status: banana
---

# Unknown Status Decision

Status parser regression sample.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('TEST-UNKNOWN-STATUS');
    assert.ok(indexed, 'decision should be indexed');
    assert.equal(indexed.status, 'active', 'unknown frontmatter status should not become a runtime EvidenceStatus');
  });

  it('accepts quoted frontmatter evidence status values', async () => {
    mkdirSync(join(docsDir, 'decisions'), { recursive: true });
    writeFileSync(
      join(docsDir, 'decisions', 'quoted-status.md'),
      `---
decision_id: TEST-QUOTED-STATUS
doc_kind: decision
status: "done"
---

# Quoted Status Decision

Status parser quoted scalar regression sample.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('TEST-QUOTED-STATUS');
    assert.ok(indexed, 'decision should be indexed');
    assert.equal(indexed.status, 'done', 'quoted frontmatter status should validate after unquoting');
  });

  it('infers architecture kind from path before nested plan/lesson directory names', async () => {
    mkdirSync(join(docsDir, 'architecture', 'plans'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'plans', 'no-frontmatter-kind.md'),
      `---
title: Architecture Planning Map
---

# Architecture Planning Map

An architecture map stored below a nested plans directory.
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:architecture/plans/no-frontmatter-kind');
    assert.ok(indexed, 'architecture nested path doc should be indexed');
    assert.equal(indexed.kind, 'architecture', 'architecture path should win over nested /plans/ segment');
    assert.equal(indexed.authority, 'validated');
  });

  it('does not close a fenced block when the matching fence line has a suffix', async () => {
    writeFileSync(
      join(docsDir, 'stories', 'nested-fence.md'),
      `---
topics: [stories]
doc_kind: note
---

# Nested Fence Sample

\`\`\`\`md
\`\`\`\`ts
## should-stay-inside-code
\`\`\`\`
`,
    );

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);
    await builder.rebuild();

    const indexed = await store.getByAnchor('doc:stories/nested-fence');
    assert.ok(indexed, 'nested fence doc should be indexed');
    assert.ok(
      !indexed.keywords?.includes('should-stay-inside-code'),
      'fence lines with suffix must not close the active fenced block',
    );
  });
});
