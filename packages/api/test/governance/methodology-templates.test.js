import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getMethodologyTemplates } from '../../dist/config/governance/methodology-templates.js';

describe('methodology-templates', () => {
  it('returns all required template files', () => {
    const templates = getMethodologyTemplates();
    const paths = templates.map((t) => t.relativePath);
    assert.ok(paths.includes('BACKLOG.md'));
    assert.ok(paths.includes('docs/SOP.md'));
    assert.ok(paths.includes('docs/features/.gitkeep'));
    assert.ok(paths.includes('docs/decisions/.gitkeep'));
    assert.ok(paths.includes('docs/discussions/.gitkeep'));
    assert.ok(paths.includes('docs/features/TEMPLATE.md'));
  });

  it('BACKLOG template has frontmatter', () => {
    const templates = getMethodologyTemplates();
    const backlog = templates.find((t) => t.relativePath === 'BACKLOG.md');
    assert.ok(backlog);
    assert.ok(backlog.content.includes('---'));
    assert.ok(backlog.content.includes('doc_kind:'));
  });

  it('SOP template uses repository commands without Clowder AI workflow assumptions', () => {
    const unknown = getMethodologyTemplates().find((t) => t.relativePath === 'docs/SOP.md');
    assert.ok(unknown);
    assert.ok(unknown.content.includes('unknown'));
    assert.ok(!unknown.content.includes('worktree'));
    assert.ok(!unknown.content.includes('quality-gate'));
    assert.ok(!unknown.content.includes('pnpm gate'));

    const discovered = getMethodologyTemplates([{ script: 'test', command: 'npm run test' }]).find(
      (t) => t.relativePath === 'docs/SOP.md',
    );
    assert.ok(discovered);
    assert.ok(discovered.content.includes('| test | `npm run test` |'));
  });

  it('Feature template has standard sections', () => {
    const templates = getMethodologyTemplates();
    const feat = templates.find((t) => t.relativePath === 'docs/features/TEMPLATE.md');
    assert.ok(feat);
    assert.ok(feat.content.includes('## Why'));
    assert.ok(feat.content.includes('## Acceptance Criteria'));
  });

  it('templates have today date filled in', () => {
    const templates = getMethodologyTemplates();
    const today = new Date().toISOString().slice(0, 10);
    const backlog = templates.find((t) => t.relativePath === 'BACKLOG.md');
    assert.ok(backlog);
    assert.ok(backlog.content.includes(today));
  });

  it('non-gitkeep templates have content', () => {
    const templates = getMethodologyTemplates();
    for (const t of templates) {
      if (!t.relativePath.endsWith('.gitkeep')) {
        assert.ok(t.content.length > 10, `${t.relativePath} should have content`);
      }
    }
  });
});
