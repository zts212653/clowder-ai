import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { namedAlphaPreviewDecision } from './lib/alpha-preview.mjs';
import { stripHarmlessRedirections, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';

const ALPHA_PREVIEW_PORT = '3011';
const RESERVED_PREVIEW_PORTS = new Set([
  '3001',
  '3002',
  '3003',
  '3004',
  '3011',
  '3012',
  '4100',
  '4111',
  '6397',
  '6398',
  '6399',
]);
const SAFE_DEV_ENV_UNSETS = new Set(['NODE_ENV', 'npm_config_production', 'NPM_CONFIG_PRODUCTION']);
const MAX_PREVIEW_LIFETIME_SECONDS = 24 * 60 * 60;
const MANAGED_PREVIEW_EXECUTION_WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'time',
  'nice',
  'nohup',
  'sudo',
  'corepack',
  'npx',
]);
const SAFE_MANAGED_PREVIEW_COORDINATE = /^[A-Za-z0-9._/@+-]+$/;
const INVALID_MANAGED_PREVIEW = Symbol('invalid-managed-preview');

/**
 * Resolve the repository-owned managed Alpha lifecycle without treating its
 * absolute project coordinate as the mutation target.
 *
 * The wrapper owns a bounded repository-native Alpha lifecycle identified by
 * cwd + port. Its absolute cwd selects that lifecycle; it does not grant an
 * arbitrary operation over the repository root. Keep this grammar deliberately
 * narrower than preview:process itself: only the canonical Alpha child and its
 * required port can receive the typed service coordinate. Arbitrary preview
 * children retain the ordinary classifier path.
 */
export function managedPreviewOperationDecision(raw, shellCwd) {
  const tokens = tokenizeSimpleShellCommand(stripHarmlessRedirections(raw));
  const invocation = parseManagedPreviewInvocation(tokens);
  if (invocation === INVALID_MANAGED_PREVIEW) return deniedPreview();
  if (!invocation) return null;
  if (targetsRuntimeSanctuary(invocation.packageCwd)) return deniedPreview();
  if (targetsRuntimeSanctuary(invocation.options.get('--cwd'))) return deniedPreview();
  const namedAlpha = namedAlphaPreviewDecision(invocation, shellCwd);
  if (namedAlpha) return namedAlpha;
  if (isAlphaPreviewCandidate(invocation)) {
    return invocation.packageCwd === undefined ? alphaPreviewDecision(invocation, shellCwd) : deniedPreview();
  }
  if (isWorktreePreviewCandidate(invocation)) return worktreePreviewDecision(invocation, shellCwd);
  return invocation.packageCwd === undefined ? null : deniedPreview();
}

export function constrainedManagedAlphaPreviewOperation(raw, shellCwd) {
  const decision = managedPreviewOperationDecision(raw, shellCwd);
  return decision?.status === 'allow' && decision.operation.kind === 'alpha' ? decision.operation : null;
}

export function constrainedManagedWorktreePreviewOperation(raw, shellCwd) {
  const decision = managedPreviewOperationDecision(raw, shellCwd);
  return decision?.status === 'allow' && decision.operation.kind === 'worktree' ? decision.operation : null;
}

function alphaPreviewDecision(invocation, shellCwd) {
  const { action, child, options, separator } = invocation;
  if (options.get('--port') !== ALPHA_PREVIEW_PORT) return deniedPreview();
  const requestedCwd = canonicalAlphaCwd(options.get('--cwd'), shellCwd);
  if (!requestedCwd) return deniedPreview();
  if (!validPreviewLifetime(action, options.get('--lifetime-seconds'))) return deniedPreview();
  if (!validPreviewAction(action, separator, child)) return deniedPreview();

  return allowedPreview({
    kind: 'alpha',
    action,
    effect: action === 'start' ? 'service_mutation' : action === 'status' ? 'read' : 'process_control',
    target: `preview://alpha${requestedCwd}:${ALPHA_PREVIEW_PORT}`,
  });
}

/**
 * Resolve the feature-worktree development lifecycle used by browser-preview.
 *
 * The workspace/runtime roots below are child configuration coordinates, not
 * mutation targets of preview:process itself. This grammar stays narrow: it
 * accepts only the repository's isolated `dev:direct` child, the production
 * environment removals required by the worktree contract, and exact sibling
 * main/worktree coordinates. Other preview children retain the ordinary
 * classifier path rather than inheriting this typed service coordinate.
 */
function worktreePreviewDecision(invocation, shellCwd) {
  const { action, child, options, packageCwd, separator } = invocation;
  const port = canonicalWorktreePreviewPort(options.get('--port'));
  if (!port) return deniedPreview();
  const requestedCwd = canonicalWorktreeCwd(options.get('--cwd'), shellCwd, packageCwd);
  if (!requestedCwd) return deniedPreview();
  if (!validPreviewLifetime(action, options.get('--lifetime-seconds'))) return deniedPreview();
  if (!validWorktreePreviewAction(action, separator, child, requestedCwd)) return deniedPreview();

  return allowedPreview({
    kind: 'worktree',
    action,
    cwd: requestedCwd,
    effect: action === 'start' ? 'service_mutation' : action === 'status' ? 'read' : 'process_control',
    target: `preview://worktree${requestedCwd}:${port}`,
  });
}

function allowedPreview(operation) {
  return { status: 'allow', operation };
}

function deniedPreview() {
  return { status: 'deny' };
}

function parseManagedPreviewInvocation(tokens) {
  if (!tokens) return null;
  const prefix = managedPreviewPrefix(tokens);
  if (!prefix) return claimsManagedPreviewFamily(tokens) ? INVALID_MANAGED_PREVIEW : null;
  const actionIndex = prefix.previewIndex + 1;
  const action = tokens[actionIndex];
  if (!['start', 'status', 'stop'].includes(action)) return INVALID_MANAGED_PREVIEW;
  const optionStart = actionIndex + 1;
  const separator = tokens.indexOf('--', optionStart);
  const optionTokens = separator >= 0 ? tokens.slice(optionStart, separator) : tokens.slice(optionStart);
  const options = parseManagedPreviewOptions(optionTokens);
  if (!options) return INVALID_MANAGED_PREVIEW;
  return {
    action,
    separator,
    options,
    packageCwd: prefix.packageCwd,
    child: separator >= 0 ? tokens.slice(separator + 1) : [],
  };
}

function managedPreviewPrefix(tokens) {
  if (tokens[0] !== 'pnpm') return null;
  if (tokens[1] === 'preview:process') return { previewIndex: 1, packageCwd: undefined };
  if (tokens[1] === '--dir' && tokens[2] !== undefined && tokens[3] === 'preview:process') {
    return { previewIndex: 3, packageCwd: tokens[2] };
  }
  return null;
}

function claimsManagedPreviewFamily(tokens) {
  const previewIndex = tokens.indexOf('preview:process');
  if (previewIndex < 0) return false;
  if (isNamedCommand(tokens[0], 'pnpm')) return true;
  if (!MANAGED_PREVIEW_EXECUTION_WRAPPERS.has(commandBasename(tokens[0]))) return false;
  return tokens.slice(1, previewIndex).some((token) => isNamedCommand(token, 'pnpm'));
}

function isNamedCommand(token, name) {
  return commandBasename(token) === name;
}

function commandBasename(token) {
  return typeof token === 'string' ? token.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() : undefined;
}

function isAlphaPreviewCandidate({ action, child, options, separator }) {
  if (Number(options.get('--port')) === Number(ALPHA_PREVIEW_PORT)) return true;
  if (action !== 'start') return false;
  return separator >= 0 && child.length === 2 && child[0] === 'pnpm' && child[1] === 'alpha:start';
}

function isWorktreePreviewCandidate({ action, child, options, separator }) {
  if (action !== 'start') {
    if (separator >= 0) return false;
    if (child.length > 0) return false;
    return claimsManagedWorktreeIdentity(options.get('--cwd'));
  }
  return separator >= 0 && looksLikeWorktreeDevChild(child);
}

function claimsManagedWorktreeIdentity(raw) {
  if (typeof raw !== 'string') return false;
  if (!isAbsolute(raw)) return false;
  if (isManagedWorktreeName(basename(raw))) return true;
  const physical = physicalDirectory(raw);
  if (physical === null) return false;
  return isManagedWorktreeName(basename(physical));
}

function isManagedWorktreeName(name) {
  return name.startsWith('cat-cafe-') && !['cat-cafe-alpha', 'cat-cafe-runtime'].includes(name);
}

function targetsRuntimeSanctuary(raw) {
  const physical = physicalDirectory(raw);
  if (physical === null) return false;
  let cursor = physical;
  while (true) {
    if (basename(cursor) === 'cat-cafe-runtime') return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function canonicalAlphaCwd(requestedCwd, shellCwd) {
  const requested = physicalDirectory(requestedCwd);
  const shell = physicalDirectory(shellCwd);
  return requested && requested === shell && basename(requested) === 'cat-cafe' ? requested : null;
}

function validPreviewLifetime(action, lifetime) {
  if (lifetime === undefined) return true;
  const seconds = Number(lifetime);
  return action === 'start' && Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_PREVIEW_LIFETIME_SECONDS;
}

function validPreviewAction(action, separator, child) {
  if (action !== 'start') return separator < 0 && child.length === 0;
  return child.length === 2 && child[0] === 'pnpm' && child[1] === 'alpha:start';
}

function canonicalWorktreePreviewPort(port) {
  if (typeof port !== 'string') return null;
  if (!/^[1-9]\d*$/.test(port)) return null;
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort)) return null;
  if (numericPort > 65535) return null;
  const canonicalPort = String(numericPort);
  return RESERVED_PREVIEW_PORTS.has(canonicalPort) ? null : canonicalPort;
}

function canonicalWorktreeCwd(requestedCwd, shellCwd, packageCwd) {
  const requested = physicalDirectory(requestedCwd);
  if (!requested) return null;
  if (packageCwd !== undefined) {
    const packageRoot = physicalDirectory(packageCwd);
    if (!packageRoot || requested !== packageRoot) return null;
  } else {
    const shell = physicalDirectory(shellCwd);
    if (requested !== shell) return null;
  }
  return isManagedWorktreeName(basename(requested)) ? requested : null;
}

function validWorktreePreviewAction(action, separator, child, requestedCwd) {
  if (action !== 'start') return separator < 0 && child.length === 0;
  if (separator < 0) return false;
  return isConstrainedWorktreeDevChild(child, requestedCwd);
}

function isConstrainedWorktreeDevChild(child, requestedCwd) {
  const index = worktreeDevCommandIndex(child, requestedCwd);
  if (index === null) return false;
  return child.length - index === 2 && child[index] === 'pnpm' && child[index + 1] === 'dev:direct';
}

function looksLikeWorktreeDevChild(child) {
  const index = worktreeDevShapeCommandIndex(child);
  return child.length - index === 2 && child[index] === 'pnpm' && child[index + 1] === 'dev:direct';
}

function worktreeDevCommandIndex(child, requestedCwd) {
  if (child[0] !== 'env') return 0;
  let index = 1;
  while (index < child.length) {
    const width = worktreeEnvironmentEntryWidth(child, index, requestedCwd);
    if (width === 0) break;
    if (width < 0) return null;
    index += width;
  }
  return index;
}

function worktreeDevShapeCommandIndex(child) {
  if (child[0] !== 'env') return 0;
  let index = 1;
  while (index < child.length) {
    if (child[index] === '-u' && child[index + 1] !== undefined) {
      index += 2;
      continue;
    }
    if (parseEnvironmentAssignment(child[index])) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function worktreeEnvironmentEntryWidth(child, index, requestedCwd) {
  const token = child[index];
  if (token === '-u') return SAFE_DEV_ENV_UNSETS.has(child[index + 1]) ? 2 : -1;
  const assignment = parseEnvironmentAssignment(token);
  if (!assignment) return 0;
  return validWorktreeCoordinateAssignment(assignment, requestedCwd) ? 1 : -1;
}

function parseEnvironmentAssignment(token) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
  return match ? { name: match[1], value: match[2] } : null;
}

function validWorktreeCoordinateAssignment({ name, value }, requestedCwd) {
  const coordinate = physicalDirectory(value);
  if (!coordinate) return false;
  if (name === 'CAT_CAFE_RUNTIME_ROOT') return coordinate === requestedCwd;
  if (name !== 'CAT_CAFE_WORKSPACE_ROOT') return false;
  return (
    basename(coordinate) === 'cat-cafe' &&
    basename(requestedCwd).startsWith('cat-cafe-') &&
    dirname(coordinate) === dirname(requestedCwd)
  );
}

function physicalDirectory(raw) {
  if (typeof raw !== 'string') return null;
  if (!SAFE_MANAGED_PREVIEW_COORDINATE.test(raw)) return null;
  if (!isAbsolute(raw)) return null;
  try {
    const physical = realpathSync(raw);
    return statSync(physical).isDirectory() ? physical : null;
  } catch {
    return null;
  }
}

function parseManagedPreviewOptions(tokens) {
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--json') {
      if (options.has(option)) return null;
      options.set(option, true);
      continue;
    }
    if (!['--port', '--cwd', '--lifetime-seconds'].includes(option) || options.has(option)) return null;
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    options.set(option, value);
    index += 1;
  }
  return options.has('--port') && options.has('--cwd') ? options : null;
}
