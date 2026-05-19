import type {
  AntigravitySideEffectJournalEntry,
  AntigravitySideEffectJournalSummary,
} from './AntigravitySideEffectJournal.js';
import { getRunCommandRefusalReason, isReadOnlyRunCommand } from './executors/RunCommandExecutor.js';

export type AntigravityResumeTier =
  | 'tier1_auto_readonly'
  | 'tier2_auto_probe_owned'
  | 'tier3_manual_shared_or_external'
  | 'tier4_manual_irreversible';

export interface AntigravityResumeProbeResult {
  kind: 'owned_target' | 'sentinel_exists' | 'worktree_exists' | 'branch_exists' | 'idempotency_key_seen';
  ok: boolean;
  reliable: boolean;
  owned?: boolean;
  target?: string;
  idempotencyKey?: string;
  summary?: string;
}

export interface AntigravityResumeTierDecision {
  tier: AntigravityResumeTier;
  canAutoResume: boolean;
  recoveryStrategy: 'auto_resume' | 'manual_card';
  reason: string;
  evidence?: string[];
}

export interface ClassifyAntigravityResumeTierInput {
  journalSummary: AntigravitySideEffectJournalSummary;
  probes?: AntigravityResumeProbeResult[];
}

const SAFE_BUILD_TEST_LINT_PATTERN =
  /^\s*(?:pnpm|npm|yarn)\s+(?:run\s+)?(?:build|test|lint|check|typecheck)(?:\s|$)|^\s*(?:node\s+--test|tsc(?:\s|$)|biome\s+check(?:\s|$))/i;
const RELEASE_OR_DESTRUCTIVE_GH_PATTERN =
  /\bgh\s+(?:pr\s+(?:merge|close)|issue\s+close|release\s+(?:create|delete|upload)|repo\s+delete)\b/i;
const CREDENTIAL_MUTATION_PATTERN =
  /(?:^|[/\s])(?:\.env(?:\.[^\s/]*)?|credentials(?:\.json)?|secrets?)(?:$|[/\s])|(?:api[_-]?key|token|password|credential|permission|oauth)/i;
const REDACTED_TARGET = '[REDACTED_TARGET]';
const SHARED_DOC_SEGMENT_PATTERN =
  /(?:^|[/\\\s"'=])(?:docs[/\\](?:features|decisions|plans|BACKLOG\.md|lessons|lessons-learned\.md|mailbox)|cat-config\.json)(?:[/\\\s"']|$)/i;
const BUSINESS_FILE_SEGMENT_PATTERN = /(?:^|[/\\\s"'=])(?:packages|apps|scripts|desktop)(?:[/\\]|$)/i;
const GH_WRITE_PATTERN =
  /\bgh\s+(?:api|auth|cache|codespace|extension|gist|gpg-key|issue|label|org|pr|project|release|repo|ruleset|run|secret|ssh-key|variable|workflow)\b/i;
const CROSS_THREAD_MCP_PATTERN =
  /\b(?:cat_cafe_(?:post_message|cross_post_message|create_task|update_task|hold_ball)|post_message|cross_post_message)\b/i;
const SHELL_CONTROL_PATTERN = /[><|;&]/;
const SHELL_SUBSTITUTION_PATTERN = /[`]/;
const SHELL_NEWLINE_PATTERN = /[\n\r]/;
const SHELL_VARIABLE_EXPANSION_PATTERN = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})/;
const GIT_SUBCOMMANDS_WITH_SHARED_WRITE = new Set(
  'am apply checkout cherry-pick clean commit merge pull push rebase release reset restore revert stash switch tag'.split(
    ' ',
  ),
);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function decision(tier: AntigravityResumeTier, reason: string, evidence?: string[]): AntigravityResumeTierDecision {
  const canAutoResume = ['tier1_auto_readonly', 'tier2_auto_probe_owned'].includes(tier);
  return {
    tier,
    canAutoResume,
    recoveryStrategy: canAutoResume ? 'auto_resume' : 'manual_card',
    reason,
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
  };
}

function targetText(entry: AntigravitySideEffectJournalEntry): string {
  return [entry.operation, entry.target, entry.effectType, entry.stepType].filter(Boolean).join(' ');
}

function tokenizeShellLike(segment: string): string[] {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!tokens) return [];
  return tokens.map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
    if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
    return token;
  });
}

function commandTokenBasename(token: string): string {
  const normalized = token.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function isRmCommandToken(token: string): boolean {
  return commandTokenBasename(token) === 'rm';
}

function isGitCommandToken(token: string): boolean {
  return commandTokenBasename(token) === 'git';
}

function gitGlobalOptionConsumesNextToken(token: string): boolean {
  if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) return true;
  return ['--config-env', '-c'].includes(token);
}

function isInlineGitGlobalOption(token: string): boolean {
  return (
    token.startsWith('-C') ||
    token.startsWith('-c') ||
    token.startsWith('--git-dir=') ||
    token.startsWith('--work-tree=') ||
    token.startsWith('--namespace=') ||
    token.startsWith('--exec-path=') ||
    token.startsWith('--config-env=')
  );
}

function gitSubcommandIndex(tokens: string[], gitIndex: number): number | null {
  for (let i = gitIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') continue;
    if (gitGlobalOptionConsumesNextToken(token)) {
      i += 1;
      continue;
    }
    if (isInlineGitGlobalOption(token)) continue;
    if (token.startsWith('-')) continue;
    return i;
  }
  return null;
}

function isGitForceFlag(token: string): boolean {
  if (token.startsWith('+') && token.length > 1) return true;
  if (token === '-f') return true;
  return /^--force(?:-with-lease)?(?:=.*)?$/.test(token);
}

function segmentHasGitForcePush(segment: string): boolean {
  const tokens = tokenizeShellLike(segment);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isGitCommandToken(tokens[i])) continue;
    const subcommandIndex = gitSubcommandIndex(tokens, i);
    if (subcommandIndex === null) continue;
    if (tokens[subcommandIndex] !== 'push') continue;
    if (tokens.slice(subcommandIndex + 1).some(isGitForceFlag)) return true;
  }
  return false;
}

function shellCommandPayload(tokens: string[]): string | null {
  const shellIndex = tokens.findIndex((token) => /^(?:bash|sh|zsh|dash)$/.test(commandTokenBasename(token)));
  if (shellIndex === -1) return null;
  const commandFlagIndex = tokens.findIndex(
    (token, index) => index > shellIndex && /^-[A-Za-z]*c[A-Za-z]*$/.test(token),
  );
  if (commandFlagIndex === -1 || commandFlagIndex === tokens.length - 1) return null;
  return tokens.slice(commandFlagIndex + 1).join(' ');
}

function hasShellPattern(text: string, predicate: (segment: string) => boolean): boolean {
  for (const segment of text.split(/[;&|\n\r]+/)) {
    if (predicate(segment)) return true;
    const payload = shellCommandPayload(tokenizeShellLike(segment));
    if (payload && hasShellPattern(payload, predicate)) return true;
  }
  return false;
}

function hasGitPattern(text: string, predicate: (segment: string) => boolean): boolean {
  return hasShellPattern(text, predicate);
}

function segmentHasGitSharedWrite(segment: string): boolean {
  const tokens = tokenizeShellLike(segment);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isGitCommandToken(tokens[i])) continue;
    const subcommandIndex = gitSubcommandIndex(tokens, i);
    if (subcommandIndex !== null && GIT_SUBCOMMANDS_WITH_SHARED_WRITE.has(tokens[subcommandIndex])) return true;
  }
  return false;
}

function rmFlagState(token: string): { recursive: boolean; force: boolean } {
  if (token === '--recursive') return { recursive: true, force: false };
  if (token === '--force') return { recursive: false, force: true };
  if (!/^-[A-Za-z]+$/.test(token)) return { recursive: false, force: false };
  return {
    recursive: /[rR]/.test(token),
    force: /f/.test(token),
  };
}

function rmCommandHasRecursiveForce(tokens: string[], rmIndex: number): boolean {
  let hasRecursive = false;
  let hasForce = false;
  for (const token of tokens.slice(rmIndex + 1)) {
    if (token === '--') break;
    const flag = rmFlagState(token);
    hasRecursive ||= flag.recursive;
    hasForce ||= flag.force;
    if (hasRecursive && hasForce) return true;
  }
  return false;
}

function segmentHasRecursiveForceRm(segment: string): boolean {
  const tokens = tokenizeShellLike(segment);
  for (let i = 0; i < tokens.length; i += 1) {
    if (isRmCommandToken(tokens[i]) && rmCommandHasRecursiveForce(tokens, i)) {
      return true;
    }
  }
  return false;
}

function hasRecursiveForceRm(text: string): boolean {
  return hasShellPattern(text, segmentHasRecursiveForceRm);
}

function hasUnsafeShellReplaySyntax(commandLine: string): boolean {
  return (
    SHELL_CONTROL_PATTERN.test(commandLine) ||
    SHELL_SUBSTITUTION_PATTERN.test(commandLine) ||
    SHELL_NEWLINE_PATTERN.test(commandLine) ||
    SHELL_VARIABLE_EXPANSION_PATTERN.test(commandLine) ||
    commandLine.includes('$(')
  );
}

function isSafeBuildTestLintCommand(commandLine: string): boolean {
  if (hasUnsafeShellReplaySyntax(commandLine)) return false;
  return SAFE_BUILD_TEST_LINT_PATTERN.test(commandLine.trim());
}

function hardRefusalReason(entry: AntigravitySideEffectJournalEntry): string | null {
  const target = typeof entry.target === 'string' ? entry.target : '';
  if (entry.operation === 'run_command' && target) {
    const commandRefusal = getRunCommandRefusalReason(target);
    if (commandRefusal) return commandRefusal;
  }
  const text = targetText(entry);
  if (hasGitPattern(text, segmentHasGitForcePush)) return 'force push is never auto-resumable';
  if (RELEASE_OR_DESTRUCTIVE_GH_PATTERN.test(text)) return 'release/merge/close operation is irreversible';
  if (target === REDACTED_TARGET) return 'redacted sensitive target requires manual review';
  if (CREDENTIAL_MUTATION_PATTERN.test(text)) return 'credential or permission mutation requires manual review';
  if (hasRecursiveForceRm(text)) return 'uncontrolled delete requires manual review';
  return null;
}

function isTier1Entry(entry: AntigravitySideEffectJournalEntry): boolean {
  if (entry.retrySafe) return true;
  if (entry.operation !== 'run_command') return false;
  const target = entry.target;
  if (!target) return false;
  return [isReadOnlyRunCommand(target), isSafeBuildTestLintCommand(target)].some(Boolean);
}

function isSharedOrExternalEntry(entry: AntigravitySideEffectJournalEntry): boolean {
  const text = targetText(entry);
  const target = typeof entry.target === 'string' ? entry.target : '';
  return (
    SHARED_DOC_SEGMENT_PATTERN.test(target) ||
    BUSINESS_FILE_SEGMENT_PATTERN.test(target) ||
    GH_WRITE_PATTERN.test(text) ||
    hasGitPattern(text, segmentHasGitSharedWrite) ||
    CROSS_THREAD_MCP_PATTERN.test(text)
  );
}

function isUnknownEntry(entry: AntigravitySideEffectJournalEntry): boolean {
  return (
    entry.status === 'unknown' ||
    entry.effectType === 'unknown' ||
    entry.effectKind === 'unknown_side_effect_capable' ||
    entry.operation === 'unknown' ||
    !entry.target
  );
}

function probeMatchesEntry(probe: AntigravityResumeProbeResult, entry: AntigravitySideEffectJournalEntry): boolean {
  if (probe.idempotencyKey && probe.idempotencyKey === entry.idempotencyKey) return true;
  if (probe.target && entry.target && probe.target === entry.target) return true;
  return false;
}

function hasSuccessfulOwnedProbe(
  entry: AntigravitySideEffectJournalEntry,
  probes: AntigravityResumeProbeResult[],
): boolean {
  return probes.some((probe) => {
    if (!probeMatchesEntry(probe, entry)) return false;
    return isSuccessfulOwnedProbe(probe);
  });
}

function isSuccessfulOwnedProbe(probe: AntigravityResumeProbeResult): boolean {
  if (probe.ok !== true) return false;
  if (probe.reliable !== true) return false;
  return probe.owned === true;
}

function probeEvidenceLabel(probe: AntigravityResumeProbeResult): string {
  return probe.summary === undefined ? probe.kind : probe.summary;
}

export function classifyAntigravityResumeTier(
  input: ClassifyAntigravityResumeTierInput,
): AntigravityResumeTierDecision {
  const entries = input.journalSummary.entries;
  const probes = input.probes === undefined ? [] : input.probes;

  if (entries.length === 0) {
    return decision('tier1_auto_readonly', 'no_side_effect');
  }

  const hardRefusals = entries.map(hardRefusalReason).filter((reason): reason is string => reason !== null);
  if (hardRefusals.length > 0) {
    return decision('tier4_manual_irreversible', hardRefusals[0], hardRefusals);
  }

  if (entries.some(isUnknownEntry)) {
    return decision('tier4_manual_irreversible', 'unknown_effect_requires_manual_review');
  }

  if (entries.some(isSharedOrExternalEntry)) {
    return decision('tier3_manual_shared_or_external', 'shared_or_external_side_effect_requires_manual_review');
  }

  if (entries.every(isTier1Entry)) {
    return decision('tier1_auto_readonly', 'readonly_build_test_lint_or_retry_safe');
  }

  const probeRequiredEntries = entries.filter((entry) => !isTier1Entry(entry));
  if (probeRequiredEntries.length > 0) {
    if (probeRequiredEntries.every((entry) => hasSuccessfulOwnedProbe(entry, probes))) {
      return decision(
        'tier2_auto_probe_owned',
        'owned_target_probe_succeeded',
        probes.filter(isSuccessfulOwnedProbe).map(probeEvidenceLabel),
      );
    }
  }

  return decision('tier4_manual_irreversible', 'insufficient_probe_evidence_fail_closed');
}
