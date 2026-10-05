#!/usr/bin/env node

// Provenance: F306 Phase C (#4083, closure #4213). This is the shared PreToolUse
// guard for both providers: managed Codex app-server/exec hooks call it directly,
// and Claude's `.claude/hooks/runtime-sanctuary-guard.sh` runs it first. A change
// here changes what every cat may execute.

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostProcessObserver, readSelfHostFacet } from './lib/self-host-facet.mjs';
import { assessSideEffect } from './lib/self-host-guard.mjs';
import { hereDocumentView } from './native-effect-heredoc.mjs';
import { decideNativeEffect, deny, invalidCandidate, isRecord } from './native-effect-policy.mjs';
import {
  classifyShellSegment,
  SHELL_EFFECT_PRIORITY,
  splitShellExecutionSegments,
} from './native-effect-shell-classifier.mjs';
import { decideShellHookPayload } from './native-effect-shell-decision.mjs';
import { classifyNativeTarget as classifyTarget } from './native-effect-target-classifier.mjs';

/** Provider-neutral policy: native-effect-policy.mjs. Re-exported for existing importers. */
export { decideNativeEffect };

/**
 * F300: the policy above is static -- it knows which targets are protected, but
 * not which of them is *us*. That answer changes per invocation, so it arrives
 * as an injected fact rather than a constant.
 *
 * "I cannot tell who hosts me" and "nothing hosts me" are different answers.
 * Only the second one is a reason to stand aside: if a deployment is named and
 * its record is missing or ambiguous, a stop that might land on it fails closed.
 */
function applySelfHostPolicy(decision, raw, cwd, resolveSelfHost, observeHost = createHostProcessObserver) {
  if (decision.decision !== 'allow') return decision;
  const { confidence, facet } = resolveSelfHost();
  // `none` means nothing claims to host this process, so there is no self to
  // protect. `unreadable` and `ambiguous` mean a deployment is named and we
  // could not pin it down -- absence of evidence, which is not permission.
  if (confidence === 'none' || !facet) return decision;

  const assessment = assessSideEffect(raw, cwd, facet, observeHost(facet));
  // Sanctuary was already settled authoritatively above -- we only reach here on
  // `allow`. Re-deciding it from the raw text would throw away the target
  // attribution the policy just did (temporary worktrees, remote repositories),
  // so this layer answers one question only: is the target us?
  if (assessment.verdict !== 'self_host' && assessment.verdict !== 'unknown') return decision;

  const reasonCode = assessment.verdict === 'unknown' ? 'self_host_unresolved' : 'self_host_stop';
  return {
    ...decision,
    decision: 'deny',
    reasonCode,
    detail: assessment.reason,
    matchedTargets: assessment.matchedTargets,
  };
}

/** Adapt Claude/Codex hook wire data, stopping provider-specific names here. */
export function decideNativeHookPayload(payload, options = {}) {
  const resolveSelfHost = options.selfHost ?? readSelfHostFacet;
  const decision = decideNativeHookPayloadWithoutSelfHost(payload);
  // Edit payloads are source data. Their file target was already classified;
  // only a shell payload can express a process action for the self-host guard.
  if (decision.source.tool !== 'shell') return decision;
  const cwd = isRecord(payload) && typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const raw = isRecord(payload)
    ? hookTargetText(
        typeof payload.tool_name === 'string' ? payload.tool_name : '',
        normalizeHookToolInput(payload.tool_input),
      )
    : '';
  return applySelfHostPolicy(decision, hereDocumentView(raw).host, cwd, resolveSelfHost, options.observeHost);
}

function decideNativeHookPayloadWithoutSelfHost(payload) {
  if (!isRecord(payload)) return deny(invalidCandidate(), 'unparseable_hook_payload');
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const toolInput = normalizeHookToolInput(payload.tool_input);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const provider = typeof payload.turn_id === 'string' || typeof payload.tool_use_id === 'string' ? 'codex' : 'claude';
  const source = { provider, tool: sourceTool(toolName), ...(cwd ? { cwd } : {}) };
  const raw = hookTargetText(toolName, toolInput);
  if (source.tool === 'shell') return decideShellHookPayload(hereDocumentView(raw), cwd, source);
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
        permissionDecisionReason: `Clowder AI native guard: ${verdict.reasonCode} (${verdict.effect} → ${verdict.target.kind})${verdict.detail ? ` — ${verdict.detail}` : ''}`,
      },
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHookCli();
}
