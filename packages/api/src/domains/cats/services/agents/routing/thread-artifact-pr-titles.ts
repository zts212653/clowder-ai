import { parsePullRequestFullRef, type ThreadArtifactDTO } from '@cat-cafe/shared';

export type PrTitleReader = (ref: string, signal: AbortSignal) => Promise<string | null>;

export async function readArtifactPrTitles<T extends ThreadArtifactDTO>(
  artifacts: readonly T[],
  reader: PrTitleReader | undefined,
): Promise<T[]> {
  if (!reader) return [...artifacts];
  const refs = [
    ...new Set(
      artifacts.flatMap((artifact) =>
        artifact.type === 'pr' && artifact.ref && parsePullRequestFullRef(artifact.ref) ? [artifact.ref] : [],
      ),
    ),
  ].slice(0, 20);
  const titles = new Map<string, string>();
  const pending = refs.values();
  // Refresh at most the 20 most recent PR titles, with four readers and one shared deadline.
  // Older works remain in the catalogue; metadata decoration cannot turn a global read into unbounded GitHub requests.
  const signal = AbortSignal.timeout(2_000);
  await Promise.all(
    Array.from({ length: Math.min(4, refs.length) }, async () => {
      for (const ref of pending) {
        if (signal.aborted) break;
        try {
          const title = await reader(ref, signal);
          if (title?.trim()) titles.set(ref, title.trim());
        } catch {
          // The original work stays visible and clickable when title metadata is unavailable.
        }
      }
    }),
  );
  return artifacts.map((artifact) => {
    if (artifact.type !== 'pr' || !artifact.ref) return artifact;
    const name = titles.get(artifact.ref) ?? (artifact.name.startsWith('PR tracking: ') ? artifact.ref : artifact.name);
    return name === artifact.name ? artifact : { ...artifact, name };
  });
}
