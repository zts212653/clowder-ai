// reverse-sanitizer.test.mjs — TDD tests for F238 Phase D reverse sanitizer.
//
// Tests run via: node --test scripts/reverse-sanitizer.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'reverse-sanitizer.mjs');

/** Run the reverse sanitizer CLI and return { stdout, stderr, exitCode }. */
function run(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 10_000,
      ...opts,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

/** Parse NDJSON stdout into array of finding objects. */
function parseFindings(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

// ── Temp dir fixture ──

let tmpDir;

beforeEach(() => {
  tmpDir = join(tmpdir(), `rs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// Task 1: Text scanning — outbound direction
// ═══════════════════════════════════════════════════════════════════

describe('outbound text scanning', () => {
  it('detects home-only term "Clowder AI" in a text file', () => {
    const file = join(tmpDir, 'readme.md');
    writeFileSync(file, 'Welcome to Clowder AI — the best place for AI cats.\n');
    const { stdout, exitCode } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);

    assert.ok(findings.length >= 1, `expected >=1 finding, got ${findings.length}`);
    const f = findings.find((f) => f.termId === 'product.primary');
    assert.ok(f, 'expected a product.primary finding');
    assert.equal(f.severity, 'P1');
    assert.equal(f.direction, 'outbound');
    assert.ok(f.file.endsWith('readme.md'));
    assert.ok(f.location.startsWith('line:'));
    assert.ok(f.matched.includes('Cat'));
    assert.ok(f.suggestion, 'expected a suggestion');
    assert.ok(exitCode !== 0, 'expected non-zero exit for P1');
  });

  it('detects multiple terms in one file', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'Clowder AI is run by co-creator and 宪宪.\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const ids = findings.map((f) => f.termId);

    assert.ok(ids.includes('product.primary'), 'should find product.primary');
    assert.ok(ids.includes('role.co_creator'), 'should find role.co_creator');
    assert.ok(ids.includes('persona.private_nicknames'), 'should find persona.private_nicknames');
  });

  it('reports no findings for a clean file', () => {
    const file = join(tmpDir, 'clean.txt');
    writeFileSync(file, 'This is a perfectly normal document with no brand terms.\n');
    const { stdout, exitCode } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    assert.equal(findings.length, 0);
    assert.equal(exitCode, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Task 2: JSON/YAML field-path reporting
// ═══════════════════════════════════════════════════════════════════

describe('JSON field-path reporting', () => {
  it('reports $.name for a violation in a JSON name field', () => {
    const file = join(tmpDir, 'manifest.json');
    writeFileSync(file, JSON.stringify({ name: 'Clowder AI Hub', version: '1.0' }));
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.hub');
    assert.ok(f, 'expected product.hub finding');
    assert.ok(f.location.startsWith('$.'), `expected JSON path, got: ${f.location}`);
    assert.ok(f.location.includes('name'), `expected path to include 'name', got: ${f.location}`);
  });

  it('reports nested JSON field paths', () => {
    const file = join(tmpDir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        app: { title: 'Your AI team collaboration space', debug: false },
      }),
    );
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.tagline');
    assert.ok(f, 'expected product.tagline finding');
    assert.equal(f.location, '$.app.title');
  });
});

describe('YAML field-path reporting', () => {
  it('reports field path for a violation in a YAML file', () => {
    const file = join(tmpDir, 'config.yaml');
    writeFileSync(file, 'product:\n  name: "Clowder AI"\n  version: 1\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.primary');
    assert.ok(f, 'expected product.primary finding');
    assert.equal(f.location, '$.product.name');
  });

  it('reports field path for .yml extension too', () => {
    const file = join(tmpDir, 'data.yml');
    writeFileSync(file, 'meta:\n  brand: "Clowder AI Hub"\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.hub');
    assert.ok(f, 'expected product.hub finding');
    assert.ok(f.location.startsWith('$.'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Task 3: Inbound direction + exceptions
// ═══════════════════════════════════════════════════════════════════

describe('inbound direction', () => {
  it('detects public-only term "Clowder AI" in inbound mode', () => {
    const file = join(tmpDir, 'prompt.md');
    writeFileSync(file, 'Welcome to Clowder AI — your team workspace.\n');
    const { stdout, exitCode } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.primary');
    assert.ok(f, 'expected product.primary finding');
    assert.equal(f.direction, 'inbound');
    assert.equal(f.severity, 'P1');
    assert.ok(f.suggestion, 'expected suggestion to home term');
    assert.ok(exitCode !== 0, 'expected non-zero exit for P1');
  });

  it('detects "Clowder AI Hub" in inbound JSON', () => {
    const file = join(tmpDir, 'manifest.json');
    writeFileSync(file, JSON.stringify({ name: 'Clowder AI Hub' }));
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.termId === 'product.hub');
    assert.ok(f);
    assert.equal(f.direction, 'inbound');
    assert.ok(f.location.startsWith('$.'));
  });
});

describe('exception handling', () => {
  it('skips @cat-cafe/* package scope pattern (product.primary exception)', () => {
    const file = join(tmpDir, 'package.json');
    writeFileSync(
      file,
      JSON.stringify({
        name: '@cat-cafe/shared',
        dependencies: { '@cat-cafe/api': '^1.0' },
      }),
    );
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    // @cat-cafe/* should NOT trigger product.primary
    const scoped = findings.filter((f) => f.matched.includes('@cat-cafe'));
    assert.equal(scoped.length, 0, `@cat-cafe/* should be excepted but found: ${JSON.stringify(scoped)}`);
  });

  it('skips cat_cafe_* MCP namespace pattern', () => {
    const file = join(tmpDir, 'skill.md');
    writeFileSync(file, 'Use `cat_cafe_search_evidence` to find memories.\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const mcp = findings.filter((f) => f.matched.includes('cat_cafe_'));
    assert.equal(mcp.length, 0, 'cat_cafe_* MCP namespace should be excepted');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Task 4: Exit codes + summary
// ═══════════════════════════════════════════════════════════════════

describe('exit codes', () => {
  it('exits 0 for clean file', () => {
    const file = join(tmpDir, 'clean.txt');
    writeFileSync(file, 'Hello world.\n');
    const { exitCode } = run(['--direction', 'outbound', file]);
    assert.equal(exitCode, 0);
  });

  it('exits 1 for P1 violation', () => {
    const file = join(tmpDir, 'leaky.txt');
    writeFileSync(file, 'Welcome to Clowder AI.\n');
    const { exitCode } = run(['--direction', 'outbound', file]);
    assert.equal(exitCode, 1);
  });

  it('exits 2 for P2-only violations', () => {
    const file = join(tmpDir, 'p2only.txt');
    // operator is P2, avoid any P1 terms
    writeFileSync(file, 'The operator decides.\n');
    const { exitCode } = run(['--direction', 'outbound', file]);
    assert.equal(exitCode, 2);
  });

  it('prints summary to stderr', () => {
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stderr } = run(['--direction', 'outbound', file]);
    assert.ok(stderr.includes('violation'), `expected summary in stderr, got: ${stderr}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R1 fixes: word boundary + overlap suppression
// ═══════════════════════════════════════════════════════════════════

describe('R1-P1: word boundary — no substring false positives', () => {
  it('does not flag "operatorId" as an "operator" violation', () => {
    const file = join(tmpDir, 'code.js');
    writeFileSync(file, 'const operatorId = 1;\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const opFindings = findings.filter((f) => f.matched === 'operator');
    assert.equal(
      opFindings.length,
      0,
      `"operator" inside "operatorId" should not match: ${JSON.stringify(opFindings)}`,
    );
  });

  it('does not flag "teamwork" as a "team" violation', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'Great teamwork on this project.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const teamFindings = findings.filter((f) => f.matched === 'team');
    assert.equal(teamFindings.length, 0, '"team" inside "teamwork" should not match');
  });

  it('still flags standalone "operator" as a violation', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'The operator manages the system.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const opFindings = findings.filter((f) => f.matched === 'operator');
    assert.ok(opFindings.length >= 1, 'standalone "operator" should still match');
  });

  it('still flags CJK terms without word boundaries', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, '问co-creator就好了\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    assert.ok(
      findings.some((f) => f.termId === 'role.co_creator'),
      'co-creator should still match even without space boundaries',
    );
  });
});

describe('R1-P2: overlap suppression — longer match wins', () => {
  it('reports only product.hub, not product.primary, for "Clowder AI Hub"', () => {
    const file = join(tmpDir, 'manifest.json');
    writeFileSync(file, JSON.stringify({ name: 'Clowder AI Hub' }));
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const atName = findings.filter((f) => f.location === '$.name');
    assert.ok(
      atName.some((f) => f.termId === 'product.hub'),
      'should have product.hub finding',
    );
    assert.ok(
      !atName.some((f) => f.termId === 'product.primary'),
      'product.primary should be suppressed — it is a substring of the product.hub match',
    );
  });

  it('still reports product.primary when "Clowder AI" appears alone', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'Welcome to Clowder AI.\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    assert.ok(findings.some((f) => f.termId === 'product.primary'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// R2 fix: same-token dedup (shared public token across multiple terms)
// ═══════════════════════════════════════════════════════════════════

describe('R2-P1: same-token dedup — highest severity wins', () => {
  it('reports exactly one finding for "operator" (P1 co_creator wins over P2 cvo)', () => {
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'The operator manages the system.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const opFindings = findings.filter((f) => f.matched === 'operator');

    assert.equal(
      opFindings.length,
      1,
      `expected exactly 1 finding for "operator" (same-token dedup), got ${opFindings.length}: ${JSON.stringify(opFindings)}`,
    );
    assert.equal(opFindings[0].severity, 'P1', 'highest severity (P1) should win');
    assert.equal(opFindings[0].termId, 'role.co_creator', 'P1 term should be kept over P2');
  });

  it('does not suppress distinct tokens at the same line', () => {
    // "operator" and "co-creator" are different matched texts — both should survive
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'The operator and co-creator collaborate.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const matched = new Set(findings.map((f) => f.matched));
    assert.ok(matched.has('operator'), 'operator should still be reported');
    assert.ok(matched.has('co-creator'), 'co-creator should still be reported');
  });
});

// ═══════════════════════════════════════════════════════════════════
// R3 fix: per-variant suggestion mapping (parallel variant lists)
// ═══════════════════════════════════════════════════════════════════

describe('R3-P1: per-variant suggestion — index-based mapping for parallel lists', () => {
  it('suggests 砚砚 for inbound "Maine Coon" (not 宪宪)', () => {
    // persona.private_nicknames: public.variants[1] = "Maine Coon" → home.variants[1] = "砚砚"
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'Ask Maine Coon for help.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.matched === 'Maine Coon');
    assert.ok(f, 'expected a finding for "Maine Coon"');
    assert.equal(f.suggestion, '砚砚', 'should map to home.variants[1], not variants[0]');
  });

  it('suggests 孟加拉猫 for inbound "Bengal" (not 布偶猫)', () => {
    // persona.breed_labels: public.variants[3] = "Bengal" → home.variants[3] = "孟加拉猫"
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'The Bengal cat helps with testing.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.matched === 'Bengal');
    assert.ok(f, 'expected a finding for "Bengal"');
    assert.equal(f.suggestion, '孟加拉猫', 'should map to home.variants[3], not variants[0]');
  });

  it('suggests maintainers for outbound "三猫" (not empty string)', () => {
    // l4.home_family: home.variants[1] = "三猫" → public.variants[1] = "maintainers"
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, '三猫一起工作。\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.matched === '三猫');
    assert.ok(f, 'expected a finding for "三猫"');
    assert.equal(f.suggestion, 'maintainers', 'should map to public.variants[1], not empty');
  });
});

// ═══════════════════════════════════════════════════════════════════
// R4 fix: canonical-first suggestion (non-parallel variant lists)
// ═══════════════════════════════════════════════════════════════════

describe('R4-P1: canonical-first — non-parallel lists use canonical, not index', () => {
  it('suggests co-creator for inbound "operator" (not @co-creator)', () => {
    // role.co_creator has 3 public variants but 7 home variants — NOT parallel.
    // home.canonical = "co-creator" must win over index-based home.variants[1] = "@co-creator".
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'The operator manages the system.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.matched === 'operator');
    assert.ok(f, 'expected a finding for "operator"');
    assert.equal(f.suggestion, 'co-creator', 'canonical should win over index mapping for non-parallel lists');
  });

  it('still uses index mapping for terms without canonical', () => {
    // persona.private_nicknames has NO canonical — index mapping still needed.
    // public.variants[2] = "Siamese" → home.variants[2] = "烁烁"
    const file = join(tmpDir, 'doc.txt');
    writeFileSync(file, 'Ask Siamese about the UI.\n');
    const { stdout } = run(['--direction', 'inbound', file]);
    const findings = parseFindings(stdout);
    const f = findings.find((f) => f.matched === 'Siamese');
    assert.ok(f, 'expected a finding for "Siamese"');
    assert.equal(f.suggestion, '烁烁', 'without canonical, index mapping should still work');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Task 5: --summary-json structured counters (AC-E2)
// ═══════════════════════════════════════════════════════════════════

describe('--summary-json flag', () => {
  it('outputs structured summary as last stdout line after NDJSON findings', () => {
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stdout } = run(['--direction', 'outbound', '--summary-json', file]);
    const lines = stdout.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]);

    assert.equal(summary._type, 'summary');
    assert.ok(summary.totalFindings >= 2, `expected >=2 total, got ${summary.totalFindings}`);
    assert.ok(typeof summary.byTermClass === 'object');
    assert.ok(typeof summary.bySeverity === 'object');
    assert.ok(typeof summary.exceptionsConsumed === 'number');
  });

  it('counts by termClass correctly', () => {
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stdout } = run(['--direction', 'outbound', '--summary-json', file]);
    const lines = stdout.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]);

    // Dictionary uses "brand" class for product terms, "role" for role terms
    assert.ok(summary.byTermClass.brand >= 1, 'should count brand terms');
    assert.ok(summary.byTermClass.role >= 1, 'should count role terms');
  });

  it('counts by severity correctly', () => {
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stdout } = run(['--direction', 'outbound', '--summary-json', file]);
    const lines = stdout.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]);

    assert.ok(summary.bySeverity.P1 >= 1, 'should count P1');
    assert.ok(summary.bySeverity.P2 >= 1, 'should count P2');
  });

  it('tracks exceptionsConsumed as a number (0 when no exceptions fire)', () => {
    // Current dictionary exceptions are safety nets — matched text (e.g. "Clowder AI")
    // never contains exception cores (e.g. "cat-cafe-skills"). Counter stays 0 but
    // must still be present as a number in the summary.
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stdout } = run(['--direction', 'outbound', '--summary-json', file]);
    const lines = stdout.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]);

    assert.equal(typeof summary.exceptionsConsumed, 'number');
    assert.equal(summary.exceptionsConsumed, 0);
  });

  it('does not output summary without --summary-json flag', () => {
    const file = join(tmpDir, 'mixed.txt');
    writeFileSync(file, 'Clowder AI is managed by operator.\n');
    const { stdout } = run(['--direction', 'outbound', file]);
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        const parsed = JSON.parse(line);
        assert.ok(!parsed._type, 'without --summary-json, no summary line expected');
      }
    }
  });

  it('outputs summary even when zero findings', () => {
    const file = join(tmpDir, 'clean.txt');
    writeFileSync(file, 'Hello world.\n');
    const { stdout } = run(['--direction', 'outbound', '--summary-json', file]);
    const summary = JSON.parse(stdout.trim());
    assert.equal(summary._type, 'summary');
    assert.equal(summary.totalFindings, 0);
    assert.equal(summary.exceptionsConsumed, 0);
  });
});

describe('CLI validation', () => {
  it('errors when --direction is missing', () => {
    const file = join(tmpDir, 'any.txt');
    writeFileSync(file, 'test\n');
    const { exitCode, stderr } = run([file]);
    assert.ok(exitCode !== 0, 'expected non-zero exit');
    assert.ok(stderr.includes('--direction'), 'expected error about --direction');
  });

  it('errors when no files provided', () => {
    const { exitCode, stderr } = run(['--direction', 'outbound']);
    assert.ok(exitCode !== 0, 'expected non-zero exit');
    assert.ok(stderr.includes('file'), 'expected error about missing files');
  });
});
