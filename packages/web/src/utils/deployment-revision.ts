import { DEPLOYMENT_REVISION_HEADER } from '@cat-cafe/shared';

export interface DeploymentRevisionState {
  client: string | null;
  observed: string | null;
  verified: boolean;
  updateRequired: boolean;
}

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;

function normalizeDeploymentRevision(value: string | null | undefined): string | null {
  const revision = value?.trim().toLowerCase();
  return revision && FULL_GIT_COMMIT.test(revision) ? revision : null;
}

const CLIENT_DEPLOYMENT_REVISION = normalizeDeploymentRevision(process.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION);
const DEPLOYMENT_REVISION_REQUIRED = process.env.NEXT_PUBLIC_CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED === '1';

export function reduceDeploymentRevision(
  state: DeploymentRevisionState,
  observed: string | null,
  verificationRequired: boolean,
  responseSucceeded: boolean,
): DeploymentRevisionState {
  if (state.updateRequired || !responseSucceeded) return state;
  // Unknown is not unequal. Only two *known* revisions that differ are a
  // mismatch; anything else stays unverified, which closes forwarding without
  // latching a reload gate the page could never clear on its own.
  if (!observed) {
    return verificationRequired ? { ...state, verified: false } : state;
  }
  if (!state.client) {
    return verificationRequired ? { ...state, observed, verified: false } : { ...state, observed, verified: true };
  }
  if (state.client === observed) {
    return { ...state, observed, verified: true };
  }
  return { ...state, observed, verified: false, updateRequired: true };
}

function sameState(a: DeploymentRevisionState, b: DeploymentRevisionState): boolean {
  return (
    a.client === b.client &&
    a.observed === b.observed &&
    a.verified === b.verified &&
    a.updateRequired === b.updateRequired
  );
}

export function createDeploymentRevisionTracker(
  client: string | null = CLIENT_DEPLOYMENT_REVISION,
  verificationRequired = DEPLOYMENT_REVISION_REQUIRED,
) {
  let state: DeploymentRevisionState = {
    client,
    observed: null,
    verified: !verificationRequired,
    updateRequired: false,
  };
  const initial = state;
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    /** Server render and hydration see the page's starting state, never a later observation. */
    readInitial: () => initial,
    observe: (observed: string | null, responseSucceeded: boolean) => {
      const next = reduceDeploymentRevision(state, observed, verificationRequired, responseSucceeded);
      // Keep the snapshot identity stable unless something changed: every API response
      // reports here, and a fresh object would re-render every subscriber each time.
      if (!sameState(next, state)) {
        state = next;
        for (const listener of listeners) listener();
      }
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Module lifetime equals the current browser document. Client-side route changes
// may remount ChatContainer, but must not teach an old bundle a new baseline.
// A real page reload evaluates the module again and intentionally resets it.
export const pageDeploymentRevision = createDeploymentRevisionTracker();

/**
 * The HTTP cache replays stored headers, so a response it may serve without asking the server
 * can carry an earlier deployment's revision (raw workspace files are `private, max-age=60`).
 * Explicit freshness or a heuristic one (Last-Modified) disqualifies it; a response that must be
 * revalidated before every reuse reaches the client with the server's current headers.
 */
function mayReplayFromHttpCache(headers: Headers): boolean {
  const cacheControl = headers.get('cache-control')?.toLowerCase() ?? '';
  if (/\b(?:no-store|no-cache)\b/.test(cacheControl)) return false;
  if (/\bimmutable\b/.test(cacheControl)) return true;
  const freshFor = /\b(?:max-age|s-maxage)=(\d+)/.exec(cacheControl);
  if (freshFor) return Number(freshFor[1]) > 0;
  return headers.has('expires') || headers.has('last-modified');
}

/**
 * Any API response can prove the runtime moved on: under load the short health probe is
 * the request most likely to time out, while ordinary responses keep completing.
 * Only a present, well-formed header on a response that cannot be a cache replay counts.
 * Absence and the server's unknown sentinel are no observation at all, so such a response can
 * never latch the gate or downgrade a page the health probe already verified.
 */
export function observeDeploymentRevisionHeader(response: Pick<Response, 'headers'>): void {
  const headers = response.headers;
  if (!headers) return;
  const revision = normalizeDeploymentRevision(headers.get(DEPLOYMENT_REVISION_HEADER));
  if (revision && !mayReplayFromHttpCache(headers)) pageDeploymentRevision.observe(revision, true);
}
