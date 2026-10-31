/**
 * F212 Phase H — AST ownership shape check (Sol R7 P1 + Sol R8 P1-A hardening).
 *
 * Contract: any `IfStatement.condition` inside a **Codex provider file**
 * (currently `CodexAgentService.ts`) that mentions BOTH `exitCode === 1`
 * AND `signal === null` is a violation — regardless of body shape. The
 * canonical spawn layer owns exit-1/signal-null decision; the provider is
 * not allowed to gate on that condition at all.
 *
 * R8 hardening:
 *   • Sol R8 P1-A #1 destructure ALIAS: `const { exitCode: code, signal: sig }
 *     = event;` — prepass walks BindingElement/BindingPattern in the file to
 *     collect `{ propertyName: localName }` alias maps, then the condition
 *     matcher accepts either the property name OR any local alias.
 *   • Sol R8 P1-A #2 reversed operands: `if (1 === event.exitCode)` — every
 *     `BinaryExpression` with `EqualsEqualsEqualsToken` is checked on BOTH
 *     sides (=== is commutative).
 *   • Sol R8 P1-A scope: guard only fires on Codex-specific provider files,
 *     not the whole providers/ tree. Sibling providers (Gemini, OpenCode, …)
 *     can legitimately have exit-code conditions without being cross-feature-
 *     gated by Phase H.
 *
 * Fail-CLOSED on missing typescript, unreadable file, or parse diagnostics.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';

/**
 * Codex-owned provider file predicate (Sol R8 P1-A scope narrowing).
 * Matches any `.ts`/`.tsx` file whose basename starts with `Codex` (e.g.
 * `CodexAgentService.ts`). This keeps the guard scoped to Codex-only —
 * sibling providers (Gemini/OpenCode/etc.) can legitimately gate on
 * `exitCode === 1 && signal === null` without being cross-feature-gated
 * by Phase H. The prefix pattern also lets test canaries use disposable
 * filenames like `Codex-canary-alias.ts` without needing to clobber the
 * real production file.
 */
export function isCodexProviderFile(filename) {
  return /^Codex.*\.tsx?$/.test(filename);
}

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';

/** Load the TypeScript compiler; throw on failure so we can fail-CLOSED. */
export function loadTypescript() {
  const require = createRequire(import.meta.url);
  return require('typescript');
}

/**
 * Collect Codex-owned provider .ts files (Sol R8 P1-A scope narrowing).
 *
 * Sol R9 P1 fail-CLOSED contract: no silent [] on missing/unreadable roots.
 *   • Missing providers root → THROW `TargetDiscoveryError('providers root
 *     does not exist')`.
 *   • Any nested `readdir` failure → THROW `TargetDiscoveryError(...)`.
 * Callers (`detectSuppressShapeInProviders`) convert both throws into
 * fail-CLOSED violations, and the empty-result case (`files.length === 0`
 * despite a valid root) is separately treated as fail-CLOSED because the
 * guard target must exist for the check to be meaningful.
 */
export class TargetDiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetDiscoveryError';
  }
}

export function collectCodexProviderFiles(repoRoot) {
  const root = join(repoRoot, PROVIDERS_DIR);
  // Missing root → fail-CLOSED. If Phase H's Codex provider directory ever
  // disappears (rename / restructure), the guard cannot report "clean" — it
  // must force the human to acknowledge the deletion.
  let rootEntries;
  try {
    rootEntries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new TargetDiscoveryError(`providers root unreadable (${root}): ${err.message.slice(0, 200)}`);
  }
  const files = [];
  const stack = [{ dir: root, entries: rootEntries }];
  while (stack.length > 0) {
    const { dir, entries } = stack.pop();
    for (const dirent of entries) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === '__tests__' || dirent.name === 'test' || dirent.name === 'dist') continue;
        let childEntries;
        try {
          childEntries = readdirSync(full, { withFileTypes: true });
        } catch (err) {
          throw new TargetDiscoveryError(`nested provider dir unreadable (${full}): ${err.message.slice(0, 200)}`);
        }
        stack.push({ dir: full, entries: childEntries });
      } else if (dirent.isFile() && isCodexProviderFile(basename(full))) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * Sol R8 P1-A #1 — walk destructure declarations to collect local-name
 * aliases. `const { exitCode: code, signal: sig } = event;` maps
 * `exitCode → code` and `signal → sig`. Bare `const { exitCode } = event;`
 * maps `exitCode → exitCode`.
 */
function collectDestructureAliases(sf, ts) {
  const aliases = { exitCode: new Set(['exitCode']), signal: new Set(['signal']) };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.BindingElement && node.name?.kind === ts.SyntaxKind.Identifier) {
      // propertyName = the property key (in `{ exitCode: code }`, propertyName='exitCode', name='code')
      // No propertyName means shorthand: `{ exitCode }` → propertyName === name.
      const propertyName = node.propertyName?.text ?? node.name.text;
      const localName = node.name.text;
      if (propertyName === 'exitCode') aliases.exitCode.add(localName);
      else if (propertyName === 'signal') aliases.signal.add(localName);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return aliases;
}

/** Match `<x>.exitCode` (PropertyAccess) or alias identifier. */
function referencesExitCode(node, ts, aliases) {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.PropertyAccessExpression && node.name?.text === 'exitCode') return true;
  if (node.kind === ts.SyntaxKind.Identifier && aliases.exitCode.has(node.text)) return true;
  return false;
}

/** Match `<x>.signal` (PropertyAccess) or alias identifier. */
function referencesSignal(node, ts, aliases) {
  if (!node) return false;
  if (node.kind === ts.SyntaxKind.PropertyAccessExpression && node.name?.text === 'signal') return true;
  if (node.kind === ts.SyntaxKind.Identifier && aliases.signal.has(node.text)) return true;
  return false;
}

/** True if `node` is the numeric literal `1`. */
function isOne(node, ts) {
  return node?.kind === ts.SyntaxKind.NumericLiteral && node.text === '1';
}
/** True if `node` is the `null` keyword. */
function isNull(node, ts) {
  return node?.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * Recursive: does the condition tree contain `<exitCodeRef> === 1` or
 * `1 === <exitCodeRef>` (Sol R8 P1-A #2 commutative equality)?
 */
function conditionHasExitCodeOne(node, ts, aliases) {
  if (!node) return false;
  if (
    node.kind === ts.SyntaxKind.BinaryExpression &&
    node.operatorToken?.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    if (referencesExitCode(node.left, ts, aliases) && isOne(node.right, ts)) return true;
    if (isOne(node.left, ts) && referencesExitCode(node.right, ts, aliases)) return true;
  }
  let hit = false;
  ts.forEachChild(node, (child) => {
    if (hit) return;
    if (conditionHasExitCodeOne(child, ts, aliases)) hit = true;
  });
  return hit;
}

/** Symmetric for `<signalRef> === null` / `null === <signalRef>`. */
function conditionHasSignalNull(node, ts, aliases) {
  if (!node) return false;
  if (
    node.kind === ts.SyntaxKind.BinaryExpression &&
    node.operatorToken?.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    if (referencesSignal(node.left, ts, aliases) && isNull(node.right, ts)) return true;
    if (isNull(node.left, ts) && referencesSignal(node.right, ts, aliases)) return true;
  }
  let hit = false;
  ts.forEachChild(node, (child) => {
    if (hit) return;
    if (conditionHasSignalNull(child, ts, aliases)) hit = true;
  });
  return hit;
}

/** Parse one file and return violation records (or `error` for fail-CLOSED). */
function scanFileAst(file, text, ts, repoRoot) {
  const violations = [];
  let sf;
  try {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  } catch (err) {
    return { violations, error: `AST parse threw: ${err.message.slice(0, 200)}` };
  }
  const diagnostics = sf.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    return {
      violations,
      error: `AST parse diagnostics: ${ts.flattenDiagnosticMessageText?.(first.messageText, '\n')?.slice(0, 200) ?? 'unknown'}`,
    };
  }
  const aliases = collectDestructureAliases(sf, ts);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.IfStatement) {
      const cond = node.expression;
      if (conditionHasExitCodeOne(cond, ts, aliases) && conditionHasSignalNull(cond, ts, aliases)) {
        const start = cond.getStart(sf);
        const { line } = sf.getLineAndCharacterOfPosition(start);
        violations.push({
          file: file.replace(`${repoRoot}/`, ''),
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations };
}

/**
 * Main entrypoint — scan Codex provider files and return violation list.
 * Fail-CLOSED on missing typescript / unreadable file / parse diagnostics.
 */
export function detectSuppressShapeInProviders(repoRoot) {
  const violations = [];

  // Sol R9 P1 fail-CLOSED #1: provider file discovery threw (missing root,
  // unreadable dir, etc.) — surface as violation, never silent skip.
  let files;
  try {
    files = collectCodexProviderFiles(repoRoot);
  } catch (err) {
    return {
      violations: [{ file: '<guard>', line: 0, error: `provider file discovery failed: ${err.message.slice(0, 200)}` }],
      skipped: false,
      failClosed: true,
    };
  }
  // Sol R9 P1 fail-CLOSED #2: zero Codex files === guard target missing.
  // If Phase H's Codex file is ever renamed / deleted / scope drifts, the guard
  // must NOT report clean. Sunsetting requires an explicit human update to the
  // guard in the same change.
  if (files.length === 0) {
    return {
      violations: [
        {
          file: '<guard>',
          line: 0,
          error: `guard target missing: no files matching /^Codex.*\\.tsx?$/ under ${PROVIDERS_DIR} — Phase H target renamed / deleted / relocated?`,
        },
      ],
      skipped: false,
      failClosed: true,
    };
  }

  let ts;
  try {
    ts = loadTypescript();
  } catch (err) {
    return {
      violations: [
        { file: '<guard>', line: 0, error: `typescript compiler unavailable: ${err.message.slice(0, 200)}` },
      ],
      skipped: false,
      failClosed: true,
    };
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      violations.push({
        file: file.replace(`${repoRoot}/`, ''),
        line: 0,
        error: `read failed: ${err.message.slice(0, 200)}`,
      });
      continue;
    }
    const result = scanFileAst(file, text, ts, repoRoot);
    if (result.error) {
      violations.push({ file: file.replace(`${repoRoot}/`, ''), line: 0, error: result.error });
      continue;
    }
    for (const v of result.violations) violations.push(v);
  }
  return { violations, skipped: files.length === 0 };
}
