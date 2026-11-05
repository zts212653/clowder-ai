import { parsePullRequestFullRef, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { apiFetch } from '../utils/api-client';

// Presentation retry state only. Successful observations persist in the plugin's original PR store.
const attempts = new Map<string, { until: number; result: Promise<string | null> }>();

export async function refreshMissingPrTitles(
  artifacts: readonly ThreadArtifactDTO[],
  scope: string,
  signal: AbortSignal,
) {
  const refs = [
    ...new Set(
      artifacts.flatMap((artifact) =>
        artifact.type === 'pr' &&
        artifact.ref &&
        artifact.name === artifact.ref &&
        parsePullRequestFullRef(artifact.ref)
          ? [artifact.ref]
          : [],
      ),
    ),
  ].slice(0, 20);
  const titles = new Map<string, string>();
  const pending = refs.values();
  await Promise.all(
    Array.from({ length: Math.min(4, refs.length) }, async () => {
      for (const ref of pending) {
        if (signal.aborted) return;
        const key = JSON.stringify([scope, ref]);
        let attempt = attempts.get(key);
        if (!attempt || attempt.until <= Date.now()) {
          const result = (async () => {
            try {
              const response = await apiFetch(
                `/api/plugins/official.github-operations/github/pr-title?${new URLSearchParams({ ref })}`,
                { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) },
              );
              if (!response.ok) return null;
              const body: unknown = await response.json();
              return body && typeof body === 'object' && 'title' in body && typeof body.title === 'string'
                ? body.title.trim() || null
                : null;
            } catch {
              return null;
            }
          })();
          attempt = { until: Date.now() + 60_000, result };
          attempts.set(key, attempt);
          if (attempts.size > 256) attempts.delete(attempts.keys().next().value!);
        }
        const title = await attempt.result;
        if (title && !signal.aborted) titles.set(ref, title);
      }
    }),
  );
  return titles;
}
