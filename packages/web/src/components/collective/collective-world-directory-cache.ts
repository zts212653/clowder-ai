import {
  type CollectiveWorldDirectoryMembership,
  collectiveHumanIdSchema,
  collectiveServiceInstanceIdSchema,
  collectiveWorldDirectoryMembershipSchema,
} from '@cat-cafe/shared';

const DIRECTORY_CACHE_KEY = 'cat-cafe:collective-world-directory:v1';
const MAX_CACHED_SERVICES = 16;
const MAX_CACHED_MEMBERSHIPS = 100;

export interface CachedWorldDirectoryService {
  readonly serviceUrl: string;
  readonly serviceInstanceId: string;
  readonly humanId: string;
  readonly memberships: readonly CollectiveWorldDirectoryMembership[];
}

interface CachedWorldDirectory {
  readonly version: 1;
  readonly services: readonly CachedWorldDirectoryService[];
}

export interface WorldDirectoryRecoveryAuthority {
  readonly serviceUrl: string;
  readonly serviceInstanceId: string;
  readonly authorizedHumanId?: string;
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
}

export function rememberCachedWorldDirectory(service: CachedWorldDirectoryService): void {
  const cached = {
    ...service,
    memberships: service.memberships.slice(0, MAX_CACHED_MEMBERSHIPS),
  } satisfies CachedWorldDirectoryService;
  const previous = readDirectoryCache().services.filter((item) => item.serviceUrl !== service.serviceUrl);
  writeDirectoryCache({ version: 1, services: [cached, ...previous].slice(0, MAX_CACHED_SERVICES) });
}

export function forgetCachedWorldDirectory(serviceUrl: string): void {
  const previous = readDirectoryCache();
  const services = previous.services.filter((item) => item.serviceUrl !== serviceUrl);
  if (services.length !== previous.services.length) writeDirectoryCache({ version: 1, services });
}

export function readRecoverableWorldDirectories(
  authorities: readonly WorldDirectoryRecoveryAuthority[],
): readonly CachedWorldDirectoryService[] {
  const previous = readDirectoryCache();
  const services = previous.services.filter((cached) =>
    authorities.some(
      (candidate) =>
        candidate.authorityStatus !== 'revoked' &&
        normalizeServiceUrl(candidate.serviceUrl) === cached.serviceUrl &&
        candidate.serviceInstanceId === cached.serviceInstanceId &&
        candidate.authorizedHumanId === cached.humanId,
    ),
  );
  if (services.length !== previous.services.length) writeDirectoryCache({ version: 1, services });
  return services;
}

export function clearWorldDirectoryCache(): void {
  writeDirectoryCache({ version: 1, services: [] });
}

function readDirectoryCache(): CachedWorldDirectory {
  if (typeof window === 'undefined') return { version: 1, services: [] };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DIRECTORY_CACHE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
      return { version: 1, services: [] };
    }
    const rawServices = (parsed as { services?: unknown }).services;
    if (!Array.isArray(rawServices)) return { version: 1, services: [] };
    return {
      version: 1,
      services: rawServices.flatMap(readCachedService).slice(0, MAX_CACHED_SERVICES),
    };
  } catch {
    return { version: 1, services: [] };
  }
}

function readCachedService(value: unknown): readonly CachedWorldDirectoryService[] {
  if (!value || typeof value !== 'object') return [];
  const candidate = value as Record<string, unknown>;
  const serviceUrl = typeof candidate.serviceUrl === 'string' ? normalizeServiceUrl(candidate.serviceUrl) : undefined;
  const serviceInstanceId = collectiveServiceInstanceIdSchema.safeParse(candidate.serviceInstanceId);
  const humanId = collectiveHumanIdSchema.safeParse(candidate.humanId);
  if (!serviceUrl || !serviceInstanceId.success || !humanId.success || !Array.isArray(candidate.memberships)) return [];
  const memberships = uniqueMemberships(
    candidate.memberships.flatMap((membership) => {
      const parsed = collectiveWorldDirectoryMembershipSchema.safeParse(membership);
      return parsed.success ? [parsed.data] : [];
    }),
  ).slice(0, MAX_CACHED_MEMBERSHIPS);
  if (!memberships.length) return [];
  return [
    {
      serviceUrl,
      serviceInstanceId: serviceInstanceId.data,
      humanId: humanId.data,
      memberships,
    },
  ];
}

function uniqueMemberships(
  memberships: readonly CollectiveWorldDirectoryMembership[],
): readonly CollectiveWorldDirectoryMembership[] {
  const seen = new Set<string>();
  return memberships.filter((membership) => {
    if (seen.has(membership.collectiveId)) return false;
    seen.add(membership.collectiveId);
    return true;
  });
}

function normalizeServiceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function writeDirectoryCache(value: CachedWorldDirectory): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify(value));
  } catch {
    /* The live directory remains authoritative when browser persistence is unavailable. */
  }
}
