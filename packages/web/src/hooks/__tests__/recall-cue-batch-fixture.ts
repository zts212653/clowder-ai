import type { apiFetch } from '@/utils/api-client';

type ApiImplementation = (...args: Parameters<typeof apiFetch>) => ReturnType<typeof apiFetch>;

/** Keep existing per-invocation data fixtures while exercising the new batch wire contract. */
export function withCueBatchFixture(implementation: ApiImplementation): ApiImplementation {
  return async (path, init, options) => {
    const url = new URL(path, 'http://fixture');
    const batch = /^\/api\/threads\/([^/]+)\/memory-cues$/.exec(url.pathname);
    if (!batch) return implementation(path, init, options);
    const ids = JSON.parse(url.searchParams.get('invocationIds') ?? '[]') as string[];
    const invocations = await Promise.all(
      ids.map(async (invocationId) => {
        const response = await implementation(
          `/api/threads/${batch[1]}/invocations/${encodeURIComponent(invocationId)}/memory-cues`,
          init,
          options,
        );
        if (!response.ok) return { invocationId, status: response.status };
        const body = (await response.json()) as { cues?: unknown[] };
        return { invocationId, status: 200, cues: body.cues };
      }),
    );
    return new Response(JSON.stringify({ invocations }));
  };
}

export function requestedCueIds(calls: Array<Parameters<typeof apiFetch>>): string[] {
  return calls.flatMap(([path]) => {
    const url = new URL(path, 'http://fixture');
    return url.pathname.endsWith('/memory-cues') && url.searchParams.has('invocationIds')
      ? (JSON.parse(url.searchParams.get('invocationIds') ?? '[]') as string[])
      : [];
  });
}
