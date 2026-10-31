import type { CliDiagnostics, CodexStartupRecovery } from './types/cli-diagnostics.js';

/** Body preference does not determine which version of this mutable projection is current. */
export function mergeCodexStartupRecovery(
  preferred: CodexStartupRecovery | undefined,
  fallback: CodexStartupRecovery | undefined,
): CodexStartupRecovery | undefined {
  if (!preferred || !fallback) return preferred ?? fallback;
  if (preferred.invocationId !== fallback.invocationId) return preferred;
  const preferredTerminal = ['ready', 'failed', 'cancelled'].includes(preferred.stage);
  const fallbackTerminal = ['ready', 'failed', 'cancelled'].includes(fallback.stage);
  if (preferredTerminal !== fallbackTerminal) return preferredTerminal ? preferred : fallback;
  return fallback.sequence > preferred.sequence ? fallback : preferred;
}

export function parseCodexStartupRecovery(value: unknown): CodexStartupRecovery | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<CodexStartupRecovery>;
  if (
    typeof state.invocationId !== 'string' ||
    !state.invocationId ||
    !['checking', 'retry_wait', 'ready', 'failed', 'cancelled'].includes(state.stage ?? '') ||
    ![state.sequence, state.attempt, state.maxAttempts].every(
      (n) => typeof n === 'number' && Number.isInteger(n) && n > 0,
    ) ||
    ![state.startedAt, state.deadlineAt, state.updatedAt].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    (state.nextRetryAt !== undefined && !Number.isFinite(state.nextRetryAt))
  )
    return null;
  return state as CodexStartupRecovery;
}

/** UI copy stays tied to typed evidence; RPC codes never imply an HTTP cause. */
export function codexAccountCheckCopy(diagnostics: CliDiagnostics, language: 'zh' | 'en' = 'zh') {
  const evidence = diagnostics.accountCheck;
  if (!evidence) return { summary: diagnostics.publicSummary, hint: diagnostics.publicHint };
  const auth = evidence.category === 'auth_rejected';
  const config = evidence.category === 'configuration_conflict';
  const unknown =
    !evidence.causeProvided && (evidence.category === 'discovery_failed' || evidence.category === 'unknown');
  if (language === 'en')
    return {
      summary: auth
        ? 'Codex account verification was rejected. This task has not started.'
        : config
          ? 'The Codex account or startup configuration did not pass verification. This task has not started.'
          : `Unable to confirm the Codex account after ${evidence.attempt} attempts. This task has not started.`,
      hint:
        auth || config
          ? 'Check the bound account and configuration in Settings → Accounts & sign-in.'
          : unknown
            ? 'Codex did not provide a more specific cause. You can wake this member again in the original conversation later.'
            : 'You can wake this member again in the original conversation later. Expand the error details to inspect this attempt.',
    };
  return {
    summary: auth
      ? '当前 Codex 账号的登录验证未通过。本次任务尚未开始。'
      : config
        ? '当前 Codex 账号或启动配置未通过核验，已停止启动。本次任务尚未开始。'
        : `暂时无法完成 Codex 账号确认。已尝试 ${evidence.attempt} 次，仍未恢复；本次任务尚未开始。`,
    hint:
      auth || config
        ? '请在“设置 → 账户与登录”检查当前绑定账号和配置。'
        : unknown
          ? 'Codex 没有返回更具体的失败原因。可稍后在原线程重新唤醒该猫。'
          : '可稍后在原线程重新唤醒该猫；展开详细错误可查看本次失败证据。',
  };
}
