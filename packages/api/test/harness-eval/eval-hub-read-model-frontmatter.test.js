import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseVerdictMarkdown } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model-helpers.js';

describe('Eval Hub verdict frontmatter parsing', () => {
  it('parses YAML frontmatter when verdict markdown uses CRLF line endings', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'f192-eval-hub-frontmatter-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const verdictPath = join(dir, 'crlf-verdict.md');
    writeFileSync(
      verdictPath,
      [
        '---',
        'feedback_type: live-verdict',
        'domain_id: eval:a2a',
        'packet_id: vhp_crlf_test',
        '---',
        '',
        '# CRLF verdict',
      ].join('\r\n'),
    );

    const parsed = parseVerdictMarkdown(verdictPath);

    assert.equal(parsed.frontmatter.feedback_type, 'live-verdict');
    assert.equal(parsed.frontmatter.domain_id, 'eval:a2a');
    assert.equal(parsed.frontmatter.packet_id, 'vhp_crlf_test');
  });
});
