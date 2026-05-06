import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

describe('BindingDryRun (AC-C4)', () => {
  let BindingDryRun;

  before(async () => {
    ({ BindingDryRun } = await import('../../dist/domains/memory/BindingDryRun.js'));
  });

  it('reports file inventory (total, markdown, excluded dirs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-run-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc');
    writeFileSync(join(dir, 'notes.md'), '# Notes');
    writeFileSync(join(dir, 'image.png'), 'binary');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');

    const report = BindingDryRun.run(dir);
    assert.equal(report.totalFiles, 3);
    assert.equal(report.markdownFiles, 2);
    assert.equal(report.excludedDirs, 1);
  });

  it('detects secrets and reports count + safe=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-secret-'));
    writeFileSync(join(dir, 'clean.md'), '# Clean\n\nSafe content.');
    writeFileSync(join(dir, 'danger.md'), '# Danger\n\ntoken: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n');

    const report = BindingDryRun.run(dir);
    assert.ok(report.secretFindings >= 1);
    assert.ok(report.secretDetails.length >= 1);
    assert.equal(report.safe, false);
  });

  it('reports safe=true when no secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-safe-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc\n\nRegular content.');

    const report = BindingDryRun.run(dir);
    assert.equal(report.safe, true);
    assert.equal(report.secretFindings, 0);
  });

  it('respects exclude patterns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-excl-'));
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'private', 'secret.md'), '# Secret\n\nkey: AKIAIOSFODNN7EXAMPLE');
    writeFileSync(join(dir, 'public.md'), '# Public\n\nSafe.');

    const report = BindingDryRun.run(dir, { exclude: ['private/**'] });
    assert.equal(report.markdownFiles, 1);
    assert.equal(report.safe, true);
  });

  it('auto-excludes .obsidian and .claude dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-auto-'));
    mkdirSync(join(dir, '.obsidian'));
    writeFileSync(
      join(dir, '.obsidian', 'config.md'),
      '# Config\n\ntoken: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ab',
    );
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.md'), '# Settings');
    writeFileSync(join(dir, 'real.md'), '# Real\n\nActual content.');

    const report = BindingDryRun.run(dir);
    assert.equal(report.markdownFiles, 1);
    assert.equal(report.excludedDirs, 2);
    assert.equal(report.safe, true);
  });

  it('reports excludedFiles count for file-level exclusion (P1-1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-exf-'));
    writeFileSync(join(dir, 'keep.md'), '# Keep');
    writeFileSync(join(dir, 'skip-me.md'), '# Skip');
    writeFileSync(join(dir, 'also-skip.md'), '# Also Skip');

    const report = BindingDryRun.run(dir, { exclude: ['skip-me.md', 'also-skip.md'] });
    assert.equal(report.markdownFiles, 1);
    assert.equal(report.excludedFiles, 2, 'should count individually excluded files');
  });

  it('reports authorityHits showing files per authority ceiling (P1-1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-auth-'));
    writeFileSync(join(dir, 'a.md'), '# A');
    writeFileSync(join(dir, 'b.md'), '# B');
    writeFileSync(join(dir, 'c.md'), '# C');

    const report = BindingDryRun.run(dir, { authorityCeiling: 'validated' });
    assert.deepEqual(report.authorityHits, { validated: 3 });
  });

  it('authorityHits defaults to validated when no ceiling specified (P1-1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-auth2-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc');

    const report = BindingDryRun.run(dir);
    assert.deepEqual(report.authorityHits, { validated: 1 });
  });

  it('throws on non-array exclude option (P1-2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-badex-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc');

    assert.throws(() => BindingDryRun.run(dir, { exclude: 'not-an-array' }), /exclude must be a string array/);
  });

  it('throws on exclude array containing non-strings (P1-2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-badex2-'));
    writeFileSync(join(dir, 'doc.md'), '# Doc');

    assert.throws(() => BindingDryRun.run(dir, { exclude: [123, null] }), /exclude must be a string array/);
  });
});
