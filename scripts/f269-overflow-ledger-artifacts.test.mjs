import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertArtifactContentsCurrent,
  assertAuditSourceMatchesBase,
  buildArtifactContents,
  buildLedger,
  computeAuditSourceFingerprint,
  renderMarkdownReport,
  scanCssLexical,
} from './f269-overflow-ledger.mjs';
import { classified, cleanupTempDirs, excluded, makeRepo, metadata } from './f269-overflow-ledger-test-fixtures.mjs';

afterEach(cleanupTempDirs);

describe('F269 overflow ledger artifacts', () => {
  it('keeps every scanner module within the 350-line hard cap', () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const sourceFiles = readdirSync(scriptsDir).filter(
      (name) => name.startsWith('f269-overflow-ledger') && name.endsWith('.mjs'),
    );
    for (const sourceFile of sourceFiles) {
      const lineCount = readFileSync(join(scriptsDir, sourceFile), 'utf8').split('\n').length;
      assert.ok(lineCount <= 350, `${sourceFile} has ${lineCount} lines`);
    }
  });

  it('renders byte-stable markdown from explicit metadata', () => {
    const rootDir = makeRepo();
    const cssScan = scanCssLexical({ rootDir });
    const classifications = cssScan.records.map((record) =>
      record.candidateKind === 'text-token' ? classified(record.id) : excluded(record.id),
    );
    const ledger = buildLedger({ metadata: metadata(), cssScan, producerRecords: [], classifications });

    const first = renderMarkdownReport(ledger);
    const second = renderMarkdownReport(ledger);
    assert.equal(first, second);
    assert.match(first, /auditBaseSha.*aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(first, /auditSourceFingerprint/);
    assert.match(first, /auditFreshnessRef.*origin\/main/);
    assert.match(first, /Raw lexical matches.*9/);
    assert.match(first, /description_generated_by: codex-sol@gpt-5\.6-sol/);
    assert.match(first, /description_confirmed_by: codex-sol/);
    assert.match(first, /Coverage equations/);
    assert.match(first, /Classification conventions/);
    assert.match(first, /record.*user-visible field.*producer contract/i);
    assert.match(first, /targetPattern.*retain/i);
    assert.match(first, /callback-anchor-helpers\.ts.*positive producer contract/i);
    assert.match(first, /does not claim that every.*\.slice\(\)/i);
    assert.match(first, /Physical producer coverage/);
    assert.match(first, /Owner distribution/);
    assert.match(first, /Top offenders/);
    assert.match(first, /Migration queue/);
  });

  it('rejects source drift after the declared audit base', () => {
    const rootDir = makeRepo();
    execFileSync('git', ['init', '--quiet'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'F269 Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.email', 'f269@example.invalid'], { cwd: rootDir });
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: rootDir });
    const auditBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();

    assert.doesNotThrow(() =>
      assertAuditSourceMatchesBase({ rootDir, auditBaseSha, sourcePaths: ['packages/web/src'] }),
    );

    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const changed = true;\n');
    assert.throws(
      () => assertAuditSourceMatchesBase({ rootDir, auditBaseSha, sourcePaths: ['packages/web/src'] }),
      /audit source drift/i,
    );

    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'New.tsx'), 'export const added = true;\n');
    assert.throws(
      () => assertAuditSourceMatchesBase({ rootDir, auditBaseSha, sourcePaths: ['packages/web/src'] }),
      /New\.tsx/,
    );
  });

  it('allows intentional audited-source changes when the freshness ref is already an ancestor', () => {
    const rootDir = makeRepo();
    execFileSync('git', ['init', '--quiet'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'F269 Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.email', 'f269@example.invalid'], { cwd: rootDir });
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: rootDir });
    execFileSync('git', ['branch', 'latest-main'], { cwd: rootDir });

    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const recovered = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'feature recovers overflow'], { cwd: rootDir });
    const auditBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();

    assert.doesNotThrow(() =>
      assertAuditSourceMatchesBase({
        rootDir,
        auditBaseSha,
        sourcePaths: ['packages/web/src'],
        freshnessRef: 'latest-main',
      }),
    );
  });

  it('allows a squash-equivalent freshness ref but rejects later source drift', () => {
    const rootDir = makeRepo();
    execFileSync('git', ['init', '--quiet'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'F269 Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.email', 'f269@example.invalid'], { cwd: rootDir });
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: rootDir });
    execFileSync('git', ['branch', 'latest-main'], { cwd: rootDir });

    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const recovered = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'feature recovers overflow'], { cwd: rootDir });
    const auditBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();

    execFileSync('git', ['switch', '--quiet', 'latest-main'], { cwd: rootDir });
    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const recovered = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'squash feature recovery'], { cwd: rootDir });

    assert.doesNotThrow(() =>
      assertAuditSourceMatchesBase({
        rootDir,
        auditBaseSha,
        sourcePaths: ['packages/web/src'],
        freshnessRef: 'latest-main',
      }),
    );

    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const drifted = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'later main drift'], { cwd: rootDir });
    assert.throws(
      () =>
        assertAuditSourceMatchesBase({
          rootDir,
          auditBaseSha,
          sourcePaths: ['packages/web/src'],
          freshnessRef: 'latest-main',
        }),
      /latest-main.*Card\.tsx/i,
    );
  });

  it('uses the source fingerprint when a squash-pruned audit commit is unavailable', () => {
    const rootDir = makeRepo();
    execFileSync('git', ['init', '--quiet'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'F269 Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.email', 'f269@example.invalid'], { cwd: rootDir });
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'squash result'], { cwd: rootDir });
    execFileSync('git', ['branch', 'feature'], { cwd: rootDir });
    execFileSync('git', ['branch', 'latest-main'], { cwd: rootDir });
    const auditSourceFingerprint = computeAuditSourceFingerprint({
      rootDir,
      ref: 'HEAD',
      sourcePaths: ['packages/web/src'],
    });
    const prunedAuditBaseSha = 'f'.repeat(40);

    assert.doesNotThrow(() =>
      assertAuditSourceMatchesBase({
        rootDir,
        auditBaseSha: prunedAuditBaseSha,
        auditSourceFingerprint,
        sourcePaths: ['packages/web/src'],
        freshnessRef: 'latest-main',
      }),
    );

    execFileSync('git', ['switch', '--quiet', 'latest-main'], { cwd: rootDir });
    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const drifted = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'later main drift'], { cwd: rootDir });
    execFileSync('git', ['switch', '--quiet', 'feature'], { cwd: rootDir });
    assert.throws(
      () =>
        assertAuditSourceMatchesBase({
          rootDir,
          auditBaseSha: prunedAuditBaseSha,
          auditSourceFingerprint,
          sourcePaths: ['packages/web/src'],
          freshnessRef: 'latest-main',
        }),
      /latest-main.*Card\.tsx/i,
    );
  });

  it('rejects audited-source drift that exists only on the latest main ref', () => {
    const rootDir = makeRepo();
    execFileSync('git', ['init', '--quiet'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.name', 'F269 Test'], { cwd: rootDir });
    execFileSync('git', ['config', 'user.email', 'f269@example.invalid'], { cwd: rootDir });
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: rootDir });
    const auditBaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim();

    execFileSync('git', ['branch', 'feature'], { cwd: rootDir });
    writeFileSync(join(rootDir, 'packages', 'web', 'src', 'Card.tsx'), 'export const mainAdvanced = true;\n');
    execFileSync('git', ['add', 'packages'], { cwd: rootDir });
    execFileSync('git', ['commit', '--quiet', '-m', 'advance main source'], { cwd: rootDir });
    execFileSync('git', ['branch', 'latest-main'], { cwd: rootDir });
    execFileSync('git', ['switch', '--quiet', 'feature'], { cwd: rootDir });

    assert.doesNotThrow(() =>
      assertAuditSourceMatchesBase({ rootDir, auditBaseSha, sourcePaths: ['packages/web/src'] }),
    );
    assert.throws(
      () =>
        assertAuditSourceMatchesBase({
          rootDir,
          auditBaseSha,
          sourcePaths: ['packages/web/src'],
          freshnessRef: 'latest-main',
        }),
      /latest-main.*Card\.tsx/i,
    );
  });

  it('builds deterministic artifacts and fails check mode on drift', () => {
    const rootDir = makeRepo();
    const cssScan = scanCssLexical({ rootDir });
    const classifications = cssScan.records.map((record) =>
      record.candidateKind === 'text-token' ? classified(record.id) : excluded(record.id),
    );
    const ledger = buildLedger({ metadata: metadata(), cssScan, producerRecords: [], classifications });
    const artifacts = buildArtifactContents(ledger);
    const jsonPath = join(rootDir, 'ledger.json');
    const markdownPath = join(rootDir, 'ledger.md');
    writeFileSync(jsonPath, artifacts.json);
    writeFileSync(markdownPath, artifacts.markdown);

    assert.doesNotThrow(() =>
      assertArtifactContentsCurrent({ artifacts, paths: { json: jsonPath, markdown: markdownPath } }),
    );

    writeFileSync(markdownPath, `${artifacts.markdown}drift\n`);
    assert.throws(
      () => assertArtifactContentsCurrent({ artifacts, paths: { json: jsonPath, markdown: markdownPath } }),
      /ledger\.md/,
    );
  });
});
