#!/usr/bin/env node
/**
 * F212 Phase H — AST ownership canaries (Cloud R2 P2 + Sol R6..R8 hardening).
 * Split from parent per Sol R8 P1-B (350-line hard cap).
 *
 * Contract: `IfStatement.condition` inside Codex provider files (basename
 * starts with `Codex`) mentioning BOTH `exitCode === 1` AND `signal === null`
 * is a violation — regardless of body shape.
 *
 * Cloud codex R1 P1 (2026-07-13) hotfix migration: every `withCanary(REAL_ROOT
 * + '/providers/*.ts', ...)` was rewritten to `makeIsolatedFixture()` + write
 * inside `fx.repoRoot`. No canary hits the real worktree's providers directory
 * anymore, so SIGKILL/SIGINT/OOM during a test cannot leak residue.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detectSuppressShapeInProviders } from './check-no-codex-provider-exit-suppression/ast-ownership.mjs';
import { makeIsolatedFixture, runGuard } from './check-no-codex-provider-exit-suppression/test-scaffold.mjs';

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';
const UTILS_DIR = 'packages/api/src/utils';

/**
 * Write a canary inside the fixture's providers dir + run the guard against
 * the fixture root. Returns `{ exitCode, stdout, stderr }` from the guard run.
 */
function guardCanaryInFixture(fx, filename, content) {
  writeFileSync(join(fx.repoRoot, PROVIDERS_DIR, filename), content);
  return runGuard({ repoRoot: fx.repoRoot });
}

describe('check-no-codex-provider-exit-suppression: AST ownership canaries', () => {
  it('cloud R2 P2 #1: RENAMED suppress in real async generator (continue) → guard fails', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode, stderr } = guardCanaryInFixture(
        fx,
        'Codex-canary-continue.ts',
        'export async function* fake(events: AsyncIterable<{ exitCode?: number; signal?: null }>) {\n' +
          '  for await (const event of events) {\n' +
          '    if (event.exitCode === 1 && event.signal === null) { continue; }\n' +
          '    yield event;\n' +
          '  }\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'R7 ownership rule catches condition regardless of body');
      assert.ok(
        stderr.includes('suppress') || stderr.includes('ownership') || stderr.includes('condition'),
        `stderr must name the violation; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R6 P1-A #1: real suppress hidden between string literals ("/*" ... "*/") → guard fails', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-string-lit.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  const open = "/*";\n' +
          '  if (event.exitCode === 1 && event.signal === null) return;\n' +
          '  const close = "*/";\n' +
          '  void open; void close; return "surfaced";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'TS AST sees real code between string literals');
    } finally {
      fx.cleanup();
    }
  });

  it('R7 supersedes R6 P1-A #2: `throw` inside `if (exit===1 && signal===null)` IS flagged (ownership rule)', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-throw.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  if (event.exitCode === 1 && event.signal === null) throw new Error("surfaced");\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'R7 ownership: condition is the violation regardless of body');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R7 P1 #1: object literal in condition (Boolean({ok:true})) does NOT hide real suppress', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-obj-cond.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  if (event.exitCode === 1 && event.signal === null && Boolean({ ok: true })) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'AST rule sees condition regardless of object literal in it');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R7 P1 #2: nested suppress path is still flagged (outer condition alone is violation)', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-nested.ts',
        'export async function* fake(events: AsyncIterable<{ exitCode?: number; signal?: null }>, produced: boolean) {\n' +
          '  for await (const event of events) {\n' +
          '    if (event.exitCode === 1 && event.signal === null) {\n' +
          '      if (produced) { return; }\n' +
          '      yield event;\n' +
          '    }\n' +
          '  }\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'outer condition alone is the violation');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R7 P1 #3: scanner failure = fail-CLOSED (guard exits non-zero on unparseable Codex file)', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-unparseable.ts',
        'export function broken(event: { exitCode: number; signal: null }) {\n' +
          '  if (event.exitCode === 1 && event.signal === null // missing brace + rest\n',
      );
      assert.equal(exitCode, 1, 'guard MUST fail-CLOSED on parse diagnostics');
    } finally {
      fx.cleanup();
    }
  });

  // ─── Sol R8 P1-A: alias, reversed operands, scope narrowing ─────────────

  it('Sol R8 P1-A #1: destructure ALIAS `const { exitCode: code, signal: sig } = event; if (code === 1 && sig === null)` → fires', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-alias.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  const { exitCode: code, signal: sig } = event;\n' +
          '  if (code === 1 && sig === null) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'R8 P1-A #1: alias map catches renamed locals');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R8 P1-A shorthand destructure `const { exitCode, signal } = event; if (exitCode === 1 && signal === null)` → fires', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-shorthand.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  const { exitCode, signal } = event;\n' +
          '  if (exitCode === 1 && signal === null) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'shorthand destructure (no rename) still fires');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R8 P1-A #2: reversed operands `if (1 === event.exitCode && null === event.signal)` → fires', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-reversed.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  if (1 === event.exitCode && null === event.signal) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'R8 P1-A #2: commutative equality catches reversed operands');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R8 P1-A #2 mixed: `if (1 === event.exitCode && event.signal === null)` → fires', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-mixed.ts',
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  if (1 === event.exitCode && event.signal === null) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 1, 'mixed operand orders in same condition still fire');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R8 P1-A scope: sibling provider file (non-Codex basename) with same condition → NOT flagged', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Gemini-canary-same-shape.ts',
        'export function siblingHandler(event: { exitCode: number; signal: null }) {\n' +
          '  if (event.exitCode === 1 && event.signal === null) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      assert.equal(exitCode, 0, 'sibling provider (non-Codex basename) is out of scope');
    } finally {
      fx.cleanup();
    }
  });

  // ─── Anti-false-positive canaries ────────────────────────────────────────

  it('Sol R7 anti-FP #a: exit-only condition (no signal check) → NOT flagged', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-exit-only.ts',
        'export function classifyExit(event: { exitCode: number }) {\n' +
          '  if (event.exitCode === 1) return "one";\n' +
          '  return "other";\n' +
          '}\n',
      );
      assert.equal(exitCode, 0, 'exit-only condition is not the ownership pattern');
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R7 anti-FP #b: non-conditional property access for logging → NOT flagged', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = guardCanaryInFixture(
        fx,
        'Codex-canary-log-only.ts',
        'export function logExitState(event: { exitCode: number; signal: null }) {\n' +
          '  return "exit=" + String(event.exitCode) + " signal=" + String(event.signal);\n' +
          '}\n',
      );
      assert.equal(exitCode, 0, 'non-conditional property access is fine');
    } finally {
      fx.cleanup();
    }
  });

  it('non-provider file with the same condition (outside providers/) → NOT flagged', () => {
    // This scope-out test needs a file OUTSIDE providers/, so build the utils
    // tree explicitly inside the fixture (default fixture only carries providers/).
    const fx = makeIsolatedFixture();
    try {
      mkdirSync(join(fx.repoRoot, UTILS_DIR), { recursive: true });
      writeFileSync(
        join(fx.repoRoot, UTILS_DIR, 'Codex-canary-utils.ts'),
        'export function fake(event: { exitCode: number; signal: null }) {\n' +
          '  if (event.exitCode === 1 && event.signal === null) return;\n' +
          '  return "ok";\n' +
          '}\n',
      );
      const { exitCode } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 0, 'shape outside providers/ tree stays clean');
    } finally {
      fx.cleanup();
    }
  });

  // ─── Sol R9 P1: fail-CLOSED on missing Codex provider target ────────────
  //
  // R8 shipped a fail-open gap Sol reproduced: if the providers root cannot
  // be read OR the entire tree contains zero Codex-prefixed files, the guard
  // silently returned `{violations: [], skipped: true}` and the orchestrator
  // printed "✅ clean — Phase H architecture preserved". Target discovery is
  // part of the guard; missing target ≠ success. Both cases must fail-CLOSED
  // so a rename / deletion / scope drift forces a human update.

  it('Sol R9 P1 #1: missing providers root → detector returns violation with failClosed=true', () => {
    // Fresh temp repo root with NO packages/api/... path.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'r9-missing-root-'));
    const result = detectSuppressShapeInProviders(tmpRoot);
    assert.equal(result.violations.length, 1, 'missing providers root MUST surface a violation');
    assert.equal(result.failClosed, true, 'must be marked failClosed');
    assert.ok(
      result.violations[0].error.includes('discovery failed') || result.violations[0].error.includes('unreadable'),
      `error must describe discovery failure; got: ${result.violations[0].error}`,
    );
  });

  it('Sol R9 P1 #2: providers root exists but no Codex target → violation with "guard target missing"', () => {
    // Fresh temp repo — create providers/ but populate ONLY sibling providers.
    // Guard target discovery finds zero Codex-prefixed files → fail-CLOSED.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'r9-empty-scope-'));
    mkdirSync(join(tmpRoot, PROVIDERS_DIR), { recursive: true });
    writeFileSync(join(tmpRoot, PROVIDERS_DIR, 'GeminiAgentService.ts'), 'export const _ = 1;\n');
    writeFileSync(join(tmpRoot, PROVIDERS_DIR, 'OpenCodeAgentService.ts'), 'export const _ = 1;\n');

    const result = detectSuppressShapeInProviders(tmpRoot);
    assert.equal(result.violations.length, 1, 'zero Codex files MUST surface a violation');
    assert.equal(result.failClosed, true);
    assert.ok(
      result.violations[0].error.includes('guard target missing') || result.violations[0].error.includes('no files'),
      `error must describe missing target; got: ${result.violations[0].error}`,
    );
  });

  it('Sol R9 P1 #3: providers root exists WITH a Codex target → clean (control)', () => {
    // Positive control: same setup but WITH a valid clean Codex file.
    // Confirms fail-CLOSED fires ONLY on missing target, not on legitimate scope.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'r9-clean-'));
    mkdirSync(join(tmpRoot, PROVIDERS_DIR), { recursive: true });
    writeFileSync(join(tmpRoot, PROVIDERS_DIR, 'CodexAgentService.ts'), 'export function noop() { return 1; }\n');
    writeFileSync(join(tmpRoot, PROVIDERS_DIR, 'GeminiAgentService.ts'), 'export const _ = 1;\n');

    const result = detectSuppressShapeInProviders(tmpRoot);
    assert.equal(result.violations.length, 0, 'valid Codex target with no suppress shape → clean');
    assert.notEqual(result.failClosed, true, 'not fail-CLOSED when target exists and is clean');
  });
});
