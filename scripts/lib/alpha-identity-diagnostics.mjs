import { execFileSync } from 'node:child_process';

const IDENTITY_FIELDS = ['cwd', 'ucomm', 'startedAt', 'startedAtEpochMs', 'startedAtFormat'];

/** Observe one unchanged Git check. Never publish argv, paths, stdout or stderr. */
export function observeAlphaGit(root, args, stage) {
  const timeoutMs = 5_000;
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const observation = {
      v: 1,
      stage,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - startedMs),
      timeoutMs,
      code: /^[A-Z][A-Z0-9_]{0,63}$/u.test(cause?.code ?? '') ? cause.code : null,
      exitCode: Number.isSafeInteger(cause?.status) ? cause.status : null,
      signal: /^SIG[A-Z0-9]{1,16}$/u.test(cause?.signal ?? '') ? cause.signal : null,
    };
    // execFileSync's error message/cause contains command output. Preserve only
    // bounded observation metadata so nested refusal logs cannot expose it.
    throw Object.assign(
      new Error(`Alpha Git observation failed; alpha_git_observation=${JSON.stringify(observation)}`),
      {
        alphaGitObservation: observation,
      },
    );
  }
}

export function alphaCheckoutRefusal(message, cause) {
  const detail = cause?.alphaGitObservation;
  return Object.assign(
    new Error(detail ? `${message}; alpha_git_observation=${JSON.stringify(detail)}` : message, { cause }),
    detail ? { alphaGitObservation: detail } : {},
  );
}

/** Keep the original capture and its failure; diagnostics do not retry or grant ownership. */
export function captureAlphaIdentity(pid, capture, subject) {
  try {
    return capture(pid);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${subject} identity unreadable (capture failed: ${detail})`, { cause });
  }
}

function known(value) {
  return typeof value === 'string' ? value.length > 0 : Number.isSafeInteger(value);
}

/** Called only after the existing ownership predicate refuses the observation. */
export function alphaIdentityRefusal({ subject, expected, current, required, mismatchMessage }) {
  const knownDifference = [expected, required].some((reference) =>
    IDENTITY_FIELDS.some(
      (field) => known(reference?.[field]) && known(current?.[field]) && reference[field] !== current[field],
    ),
  );
  const argvUnavailable = expected?.argvAvailable === false || current?.argvAvailable === false;
  const unreadable = !knownDifference && argvUnavailable;
  return Object.assign(new Error(unreadable ? `${subject} identity unreadable (argv unavailable)` : mismatchMessage), {
    code: unreadable ? 'ALPHA_IDENTITY_ARGV_UNAVAILABLE' : 'ALPHA_IDENTITY_MISMATCH',
  });
}
