#!/usr/bin/env node

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  classifyShellSegment,
  isDataDrivenPipelineConsumer,
  SHELL_EFFECT_PRIORITY,
  splitPipelineSegments,
  splitShellExecutionSegments,
} from './native-effect-shell-classifier.mjs';
import { classifyNativeTarget as classifyTarget } from './native-effect-target-classifier.mjs';

const EFFECTS = new Set([
  'read',
  'repository_refresh',
  'write',
  'delete',
  'process_control',
  'repository_rewrite',
  'service_mutation',
  'unknown',
]);
const TARGETS = new Set(['ordinary', 'runtime_sanctuary', 'redis_sanctuary', 'broad_root', 'protected_branch']);

/** Pure provider-neutral policy. Filesystem capability remains outside this guard. */
export function decideNativeEffect(candidate) {
  if (!isCandidate(candidate)) return deny(candidate, 'invalid_candidate');
  if (candidate.effect === 'read') return allow(candidate, 'read_only');
  if (candidate.effect === 'repository_refresh') return allow(candidate, 'remote_tracking_refresh');
  const protectedDecision = PROTECTED_POLICIES[candidate.target.kind]?.(candidate);
  if (protectedDecision) return protectedDecision;
  return allow(candidate, candidate.target.kind === 'ordinary' ? 'ordinary_policy_deferred' : 'reversible_effect');
}

const PROTECTED_POLICIES = {
  runtime_sanctuary: (candidate) =>
    deny(candidate, candidate.effect === 'unknown' ? 'protected_target_unparsed' : 'runtime_sanctuary_mutation'),
  redis_sanctuary: (candidate) =>
    ['service_mutation', 'process_control', 'delete', 'repository_rewrite', 'unknown'].includes(candidate.effect)
      ? deny(candidate, candidate.effect === 'unknown' ? 'protected_target_unparsed' : 'redis_sanctuary_mutation')
      : null,
  broad_root: (candidate) =>
    ['delete', 'repository_rewrite', 'process_control', 'service_mutation', 'unknown'].includes(candidate.effect)
      ? deny(candidate, candidate.effect === 'delete' ? 'broad_root_delete' : 'broad_root_irreversible')
      : null,
  protected_branch: (candidate) =>
    ['delete', 'repository_rewrite', 'unknown'].includes(candidate.effect)
      ? deny(candidate, candidate.effect === 'unknown' ? 'protected_target_unparsed' : 'protected_branch_force_rewrite')
      : null,
};

/** Adapt Claude/Codex hook wire data, stopping provider-specific names here. */
export function decideNativeHookPayload(payload) {
  if (!isRecord(payload)) return deny(invalidCandidate(), 'unparseable_hook_payload');
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput = normalizeHookToolInput(payload.tool_input);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const provider = typeof payload.turn_id === 'string' || typeof payload.tool_use_id === 'string' ? 'codex' : 'claude';
  const source = { provider, tool: sourceTool(toolName), ...(cwd ? { cwd } : {}) };
  const raw = hookTargetText(toolName, toolInput);
  if (source.tool === 'shell') return decideShellHookPayload(raw, cwd, source);
  const effect = classifyEffect(toolName, raw);
  const targetText = toolName === 'apply_patch' ? applyPatchTargetText(raw) : raw;
  const patchTargets = toolName === 'apply_patch' && targetText.length > 0 ? targetText.split('\n') : [];
  const hasExplicitPatchTarget = patchTargets.length > 0;
  const hasOnlyAbsolutePatchTargets = hasExplicitPatchTarget && patchTargets.every(isAbsolutePatchTarget);
  const candidate = {
    effect,
    target: classifyTarget(targetText, hasOnlyAbsolutePatchTargets ? undefined : cwd, effect, patchTargets[0]),
    source,
  };
  return decideNativeEffect(candidate);
}

function normalizeHookToolInput(toolInput) {
  if (isRecord(toolInput)) return toolInput;
  if (typeof toolInput === 'string') return { command: toolInput };
  return {};
}

function decideShellHookPayload(raw, cwd, source) {
  const dataDrivenConsumer = splitPipelineSegments(raw).slice(1).find(isDataDrivenPipelineConsumer);
  if (dataDrivenConsumer) {
    const effect = classifyShellSegment(dataDrivenConsumer);
    const decision = decideNativeEffect({ effect, target: classifyTarget(raw, cwd, effect), source });
    if (decision.decision === 'deny') return decision;
  }
  const segments = splitShellExecutionSegments(raw);
  const candidates = (segments.length > 0 ? segments : ['']).map((segment) => {
    const effect = classifyShellSegment(segment);
    return { effect, target: classifyTarget(segment, cwd, effect), source };
  });
  const decisions = candidates.map(decideNativeEffect);
  const denied = decisions.find((decision) => decision.decision === 'deny');
  if (denied) return denied;

  const definite = candidates.filter((candidate) => candidate.effect !== 'unknown');
  const representative = definite.reduce(
    (current, candidate) =>
      !current ||
      (SHELL_EFFECT_PRIORITY.get(candidate.effect) ?? -1) > (SHELL_EFFECT_PRIORITY.get(current.effect) ?? -1)
        ? candidate
        : current,
    null,
  );
  const aggregateEffect = (representative ?? candidates[0]).effect;
  return decideNativeEffect({
    effect: aggregateEffect,
    target: classifyTarget(raw, cwd, aggregateEffect),
    source,
  });
}

function classifyEffect(toolName, raw) {
  if (toolName === 'apply_patch') return /^\*\*\* Delete File:/m.test(raw) ? 'delete' : 'write';
  if (toolName === 'Edit' || toolName === 'Write') return 'write';
  if (!raw.trim()) return 'unknown';
  const effects = splitShellExecutionSegments(raw).map(classifyShellSegment);
  if (effects.length === 0) return 'unknown';
  return effects.reduce((current, candidate) =>
    (SHELL_EFFECT_PRIORITY.get(candidate) ?? -1) > (SHELL_EFFECT_PRIORITY.get(current) ?? -1) ? candidate : current,
  );
}

function hookTargetText(toolName, toolInput) {
  if (toolName === 'Edit' || toolName === 'Write') {
    return typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  }
  for (const key of ['command', 'cmd', 'patch']) {
    if (typeof toolInput[key] === 'string') return toolInput[key];
  }
  return '';
}

function applyPatchTargetText(raw) {
  return [...raw.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*(.+)$/gm)]
    .map((match) => match[1].trim())
    .join('\n');
}

function isAbsolutePatchTarget(target) {
  return isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) || /^\\\\/.test(target);
}

function sourceTool(toolName) {
  if (toolName === 'Edit' || toolName === 'apply_patch') return 'edit';
  if (toolName === 'Write') return 'write';
  return 'shell';
}

function isCandidate(value) {
  return (
    isRecord(value) &&
    EFFECTS.has(value.effect) &&
    isRecord(value.target) &&
    TARGETS.has(value.target.kind) &&
    typeof value.target.value === 'string' &&
    isRecord(value.source) &&
    typeof value.source.provider === 'string' &&
    ['shell', 'edit', 'write'].includes(value.source.tool)
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidCandidate() {
  return {
    effect: 'unknown',
    target: { kind: 'ordinary', value: '<invalid>' },
    source: { provider: 'unknown', tool: 'shell' },
  };
}

function allow(candidate, reasonCode) {
  return {
    decision: 'allow',
    reasonCode,
    effect: candidate.effect,
    target: candidate.target,
    source: candidate.source,
  };
}

function deny(candidate, reasonCode) {
  const safe = isCandidate(candidate) ? candidate : invalidCandidate();
  return { decision: 'deny', reasonCode, effect: safe.effect, target: safe.target, source: safe.source };
}

async function runHookCli() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  const verdict = decideNativeHookPayload(payload);
  if (verdict.decision === 'allow') return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Clowder AI native guard: ${verdict.reasonCode} (${verdict.effect} → ${verdict.target.kind})`,
      },
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHookCli();
}
