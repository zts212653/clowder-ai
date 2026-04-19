import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

# Cat Cafe 花名册 — 名字的由来

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
