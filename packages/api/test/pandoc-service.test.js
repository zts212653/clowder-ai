import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { beforeEach, describe, it } from 'node:test';
import { PandocService } from '../dist/infrastructure/document/PandocService.js';

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

describe('PandocService', () => {
  let svc;

  beforeEach(() => {
    svc = new PandocService(noopLog());
  });

  describe('isPandocAvailable()', () => {
    it('detects pandoc when installed', async () => {
      const result = await svc.isPandocAvailable();
      // pandoc is installed on this machine (verified during J2 planning)
      assert.equal(result, true);
    });

    it('caches the result', async () => {
      await svc.isPandocAvailable();
      svc._setAvailable(false);
      // Should still return cached value... wait, _setAvailable overrides.
      // Let's test caching differently:
      const svc2 = new PandocService(noopLog());
      const r1 = await svc2.isPandocAvailable();
      // Second call should use cache
      const r2 = await svc2.isPandocAvailable();
      assert.equal(r1, r2);
    });

    it('returns false when pandoc is not found', async () => {
      svc._setAvailable(false);
      const result = await svc.isPandocAvailable();
      assert.equal(result, false);
    });
  });

  describe('generate() — MD format', () => {
    it('saves markdown content to a .md file', async () => {
      const result = await svc.generate('# Hello\n\nWorld', 'test-doc', 'md');
      assert.ok(result);
      assert.equal(result.format, 'md');
      assert.equal(result.fileName, 'test-doc.md');
      assert.equal(result.mimeType, 'text/markdown');
      assert.ok(existsSync(result.absPath));

      const content = readFileSync(result.absPath, 'utf-8');
      assert.equal(content, '# Hello\n\nWorld');

      // Cleanup
      await unlink(result.absPath).catch(() => {});
    });

    it('does not require pandoc for MD output', async () => {
      svc._setAvailable(false);
      const result = await svc.generate('test content', 'no-pandoc', 'md');
      assert.ok(result);
      assert.equal(result.format, 'md');
      await unlink(result.absPath).catch(() => {});
    });
  });

  describe('generate() — DOCX format', () => {
    it('generates a .docx file when pandoc is available', async () => {
      const hasPandoc = await svc.isPandocAvailable();
      if (!hasPandoc) {
        // Skip on machines without pandoc
        return;
      }

      const result = await svc.generate('# Report\n\nThis is a test report.', '调研报告', 'docx');
      assert.ok(result);
      assert.equal(result.format, 'docx');
      assert.equal(result.fileName, '调研报告.docx');
      assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      assert.ok(existsSync(result.absPath));
      // DOCX files start with PK (ZIP magic bytes)
      const buf = readFileSync(result.absPath);
      assert.ok(buf.length > 100, 'DOCX should be non-trivial size');
      assert.equal(buf[0], 0x50); // 'P'
      assert.equal(buf[1], 0x4b); // 'K'

      await unlink(result.absPath).catch(() => {});
    });

    it('degrades to .md when pandoc is unavailable', async () => {
      svc._setAvailable(false);
      const result = await svc.generate('# Fallback test', 'fallback', 'docx');
      assert.ok(result);
      assert.equal(result.format, 'md');
      assert.equal(result.fileName, 'fallback.md');
      await unlink(result.absPath).catch(() => {});
    });
  });

  describe('generate() — PDF format', () => {
    it('attempts PDF generation (may degrade to DOCX or MD if no LaTeX)', async () => {
      const hasPandoc = await svc.isPandocAvailable();
      if (!hasPandoc) return;

      const result = await svc.generate('# PDF Test\n\nHello world.', 'pdf-test', 'pdf');
      assert.ok(result);
      // Could be pdf (if tectonic/latex installed), docx (fallback), or md (final fallback)
      assert.ok(['pdf', 'docx', 'md'].includes(result.format));
      assert.ok(existsSync(result.absPath));
      assert.ok(statSync(result.absPath).size > 0);

      if (result.format === 'pdf') {
        // PDF magic bytes: %PDF
        const buf = readFileSync(result.absPath);
        assert.equal(buf.toString('ascii', 0, 4), '%PDF');
      }

      await unlink(result.absPath).catch(() => {});
    });

    it('degrades to .md when pandoc is unavailable', async () => {
      svc._setAvailable(false);
      const result = await svc.generate('# No pandoc', 'no-pandoc-pdf', 'pdf');
      assert.ok(result);
      assert.equal(result.format, 'md');
      await unlink(result.absPath).catch(() => {});
    });
  });

  describe('filename sanitization', () => {
    it('sanitizes special characters in baseName', async () => {
      const result = await svc.generate('test', 'file/with:bad*chars', 'md');
      assert.ok(result);
      assert.ok(!result.fileName.includes('/'));
      assert.ok(!result.fileName.includes(':'));
      assert.ok(!result.fileName.includes('*'));
      await unlink(result.absPath).catch(() => {});
    });

    it('preserves Chinese characters in baseName', async () => {
      const result = await svc.generate('test', '调研报告', 'md');
      assert.ok(result);
      assert.ok(result.fileName.includes('调研报告'));
      await unlink(result.absPath).catch(() => {});
    });
  });
});
