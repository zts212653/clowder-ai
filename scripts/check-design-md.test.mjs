import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { lintDesignMd } from './check-design-md.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DESIGN_MD = join(ROOT, 'DESIGN.md');

function readFrontMatter(file) {
  const text = readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file} has no YAML front matter`);
  return parseYaml(match[1]);
}

function writeFixture(name, body) {
  const dir = mkdtempSync(join(tmpdir(), `design-md-gate-${name}-`));
  const file = join(dir, 'DESIGN.md');
  writeFileSync(file, body);
  return file;
}

// WCAG 2.x relative luminance + contrast ratio for #rrggbb values.
function luminance(hex) {
  const value = hex.replace('#', '');
  assert.match(value, /^[0-9a-f]{6}$/i, `expected #rrggbb, got ${hex}`);
  const channel = (i) => {
    const c = Number.parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('repo-root DESIGN.md passes the gate with zero errors and zero warnings', () => {
  const { ok, diagnostics } = lintDesignMd(DESIGN_MD);
  assert.equal(ok, true, diagnostics.map((d) => `${d.rule}: ${d.message}`).join('\n'));
});

test('a DESIGN.md with a broken token reference fails the gate with an error', () => {
  const file = writeFixture(
    'broken-ref',
    [
      '---',
      'version: alpha',
      'name: Broken',
      'colors:',
      '  primary: "#b05f45"',
      'components:',
      '  button-primary:',
      '    backgroundColor: "{colors.does-not-exist}"',
      '---',
      '',
      '## Overview',
      '',
      'x',
      '',
    ].join('\n'),
  );
  const { ok, diagnostics } = lintDesignMd(file);
  assert.equal(ok, false);
  assert.ok(diagnostics.some((d) => d.severity === 'error' && d.rule === 'broken-ref'));
});

test('a DESIGN.md that only produces warnings (low-contrast pair) still fails the gate', () => {
  const file = writeFixture(
    'warning-only',
    [
      '---',
      'version: alpha',
      'name: Warning only',
      'colors:',
      '  primary: "#b05f45"',
      '  on-primary: "#ffffff"',
      '  faint: "#6c6a64"',
      '  surface-3: "#e8e0d2"',
      'components:',
      '  button-primary:',
      '    backgroundColor: "{colors.primary}"',
      '    textColor: "{colors.on-primary}"',
      '  faint-label:',
      '    backgroundColor: "{colors.surface-3}"',
      '    textColor: "{colors.faint}"',
      '---',
      '',
      '## Overview',
      '',
      'x',
      '',
    ].join('\n'),
  );
  const { ok, diagnostics, summary } = lintDesignMd(file);
  assert.equal(ok, false);
  assert.equal(summary.errors, 0, 'fixture must be error-free so the warning branch is what fails');
  assert.ok(
    diagnostics.some((d) => d.severity === 'warning' && d.rule === 'contrast-ratio'),
    'expected a contrast-ratio warning',
  );
});

// Every role pairing the prose allows must clear WCAG AA (4.5:1). The linter only
// checks pairs that happen to be declared as components; this matrix is the contract.
test('every prose-allowed text/surface role pair in DESIGN.md is WCAG AA (>= 4.5:1)', () => {
  const { colors } = readFrontMatter(DESIGN_MD);
  const lightSurfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3'];
  const darkSurfaces = ['dark-canvas', 'dark-surface-1', 'dark-surface-2', 'dark-surface-3'];
  const allowed = [
    ...['ink', 'body', 'muted'].flatMap((fg) => lightSurfaces.map((bg) => [fg, bg])),
    ...[...lightSurfaces, 'primary-soft'].map((bg) => ['primary-active', bg]),
    ['on-primary', 'primary'],
    ['on-primary', 'primary-active'],
    ['body', 'primary-soft'],
    ...['on-dark', 'on-dark-muted'].flatMap((fg) => darkSurfaces.map((bg) => [fg, bg])),
  ];
  const failures = [];
  for (const [fg, bg] of allowed) {
    assert.ok(colors[fg], `missing color token ${fg}`);
    assert.ok(colors[bg], `missing color token ${bg}`);
    const ratio = contrastRatio(colors[fg], colors[bg]);
    if (ratio < 4.5) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
});

// Status dots, error borders and the focus ring are non-text UI elements: WCAG 1.4.11
// requires >= 3:1 against every surface the prose allows them on.
test('every prose-allowed non-text semantic/focus pair in DESIGN.md is >= 3:1', () => {
  const { colors } = readFrontMatter(DESIGN_MD);
  const lightSurfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3'];
  const darkSurfaces = ['dark-canvas', 'dark-surface-1', 'dark-surface-2', 'dark-surface-3'];
  const allowed = [
    ...['success', 'warning', 'critical', 'info', 'focus'].flatMap((fg) => lightSurfaces.map((bg) => [fg, bg])),
    ...['dark-success', 'dark-warning', 'dark-critical', 'dark-info', 'dark-focus'].flatMap((fg) =>
      darkSurfaces.map((bg) => [fg, bg]),
    ),
  ];
  const failures = [];
  for (const [fg, bg] of allowed) {
    assert.ok(colors[fg], `missing color token ${fg}`);
    assert.ok(colors[bg], `missing color token ${bg}`);
    const ratio = contrastRatio(colors[fg], colors[bg]);
    if (ratio < 3) failures.push(`${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, []);
});

test('the gate never resolves a package bin (cross-platform: no design.md/designmd spawn)', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'check-design-md.mjs'), 'utf8');
  assert.doesNotMatch(source, /child_process/, 'gate must import the linter, not spawn a bin');
  assert.doesNotMatch(source, /['"]design\.md['"]|designmd/, 'gate must not reference a bin name');
  assert.match(source, /from '@google\/design\.md\/linter'/);
});

test('DESIGN.md components never use primary or semantic colors as text', () => {
  const { components } = readFrontMatter(DESIGN_MD);
  const forbiddenText = new Set([
    '{colors.primary}',
    '{colors.success}',
    '{colors.warning}',
    '{colors.critical}',
    '{colors.info}',
    '{colors.dark-success}',
    '{colors.dark-warning}',
    '{colors.dark-critical}',
    '{colors.dark-info}',
    '{colors.focus}',
    '{colors.dark-focus}',
  ]);
  const offenders = Object.entries(components)
    .filter(([, spec]) => spec.textColor && forbiddenText.has(spec.textColor))
    .map(([name, spec]) => `${name}: ${spec.textColor}`);
  assert.deepEqual(offenders, []);
});

// The focus indicator is an outer solid ring separated from the control by an
// offset gap, so it is only ever adjacent to the host surface (covered by the
// 3:1 matrix above). Guard the placement contract so an inner/alpha ring cannot
// creep back in and silently invalidate that matrix.
test('DESIGN.md focus contract is an outer 2px solid ring with a 2px offset gap', () => {
  const text = readFileSync(DESIGN_MD, 'utf8');
  const { components } = readFrontMatter(DESIGN_MD);

  // Components bind to their own tokens (the 3:1 matrix is computed on tokens,
  // so a component pointing elsewhere would silently escape it).
  assert.equal(components['focus-ring'].backgroundColor, '{colors.focus}');
  assert.equal(components['focus-ring'].size, '2px');
  assert.equal(components['dark-focus-ring'].backgroundColor, '{colors.dark-focus}');
  assert.equal(components['dark-focus-ring'].size, '2px');

  // Canonical placement contract lives in one place: the "焦点" row of the
  // Elevation & Depth table. Only that row is guarded, so unrelated prose may
  // freely mention percentages.
  const elevation = text.match(/## Elevation & Depth\n([\s\S]*?)\n## /);
  assert.ok(elevation, 'Elevation & Depth section missing');
  const focusRow = elevation[1].split('\n').find((line) => /^\| 焦点 \|/.test(line));
  assert.ok(focusRow, 'Elevation table has no 焦点 row');
  assert.match(focusRow, /outline: 2px solid \{colors\.focus\}/);
  assert.match(focusRow, /outline-offset: 2px/);
  assert.match(focusRow, /\{colors\.dark-focus\}/);
  assert.doesNotMatch(
    focusRow,
    /opacity|rgba\(|hsla\(|\/\s*0?\.\d|\d+%|透明|alpha/i,
    'focus row must not describe a translucent/composited ring',
  );
});

test('DESIGN.md rounded.full and rounded.pill are both 9999px', () => {
  const { rounded } = readFrontMatter(DESIGN_MD);
  assert.equal(rounded.full, '9999px');
  assert.equal(rounded.pill, '9999px');
});
