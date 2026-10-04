import {
  type CollectiveClientWorldDirectory,
  collectiveClientWorldDirectorySchema,
  collectiveIdSchema,
  collectiveServiceInstanceIdSchema,
} from '@cat-cafe/shared';

export interface WorldDirectoryGeneration {
  readonly bridgeId: string;
  readonly revision: number;
  readonly serviceOrigin: string;
  readonly expectedServiceInstanceId?: string;
  readonly humanId?: string;
}

export function acceptWorldDirectory(input: {
  readonly data: unknown;
  readonly eventOrigin: string;
  readonly sourceMatches: boolean;
  readonly generation: WorldDirectoryGeneration;
}): CollectiveClientWorldDirectory | undefined {
  const directory = candidateWorldDirectory(input);
  if (!directory) return undefined;
  if (
    input.generation.expectedServiceInstanceId &&
    directory.serviceInstanceId !== input.generation.expectedServiceInstanceId
  ) {
    return undefined;
  }
  if (input.generation.humanId && directory.state === 'ready' && directory.humanId !== input.generation.humanId) {
    return undefined;
  }
  return directory;
}

export function worldDirectoryServiceMismatch(input: {
  readonly data: unknown;
  readonly eventOrigin: string;
  readonly sourceMatches: boolean;
  readonly generation: WorldDirectoryGeneration;
}): boolean {
  const directory = candidateWorldDirectory(input);
  return Boolean(
    directory?.serviceInstanceId &&
      input.generation.expectedServiceInstanceId &&
      directory.serviceInstanceId !== input.generation.expectedServiceInstanceId,
  );
}

function candidateWorldDirectory(input: {
  readonly data: unknown;
  readonly eventOrigin: string;
  readonly sourceMatches: boolean;
  readonly generation: WorldDirectoryGeneration;
}): CollectiveClientWorldDirectory | undefined {
  if (!input.sourceMatches || input.eventOrigin !== input.generation.serviceOrigin) return undefined;
  const parsed = collectiveClientWorldDirectorySchema.safeParse(input.data);
  if (!parsed.success) return undefined;
  const directory = parsed.data;
  return directory.bridgeId === input.generation.bridgeId && directory.revision > input.generation.revision
    ? directory
    : undefined;
}

type ReadyDirectory = Extract<CollectiveClientWorldDirectory, { state: 'ready' }>;

export type ExplicitWorldTargetResolution =
  | { readonly kind: 'selected'; readonly membership: ReadyDirectory['memberships'][number] }
  | { readonly kind: 'service_mismatch' }
  | { readonly kind: 'missing_membership' }
  | {
      readonly kind: 'directory_unavailable';
      readonly state: Exclude<CollectiveClientWorldDirectory['state'], 'ready'>;
    };

export function resolveExplicitWorldTarget(
  directory: CollectiveClientWorldDirectory,
  target: { readonly serviceInstanceId: string; readonly collectiveId: string },
): ExplicitWorldTargetResolution {
  if (directory.state !== 'ready') return { kind: 'directory_unavailable', state: directory.state };
  if (directory.serviceInstanceId !== target.serviceInstanceId) return { kind: 'service_mismatch' };
  const membership = directory.memberships.find((candidate) => candidate.collectiveId === target.collectiveId);
  return membership ? { kind: 'selected', membership } : { kind: 'missing_membership' };
}

export interface CollectiveWorldTarget {
  readonly serviceUrl: string;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
}

export type ParsedCollectiveWorldTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'target'; readonly target: CollectiveWorldTarget };

const worldTargetFields = ['serviceUrl', 'serviceInstanceId', 'collectiveId'] as const;

export function parseCollectiveWorldTarget(actionRef: string): ParsedCollectiveWorldTarget {
  let url: URL;
  try {
    url = new URL(actionRef, 'https://cat-cafe.invalid');
  } catch {
    return { kind: 'invalid' };
  }
  if (url.origin !== 'https://cat-cafe.invalid' || url.pathname !== '/collective' || url.hash) {
    return { kind: 'invalid' };
  }
  const hasTargetField = worldTargetFields.some((field) => url.searchParams.has(field));
  if (!hasTargetField) return { kind: 'none' };
  if (
    [...url.searchParams.keys()].some(
      (key) => !worldTargetFields.includes(key as (typeof worldTargetFields)[number]),
    ) ||
    worldTargetFields.some((field) => url.searchParams.getAll(field).length !== 1)
  ) {
    return { kind: 'invalid' };
  }
  const serviceUrl = normalizeServiceOrigin(url.searchParams.get('serviceUrl'));
  const serviceInstanceId = collectiveServiceInstanceIdSchema.safeParse(url.searchParams.get('serviceInstanceId'));
  const collectiveId = collectiveIdSchema.safeParse(url.searchParams.get('collectiveId'));
  if (!serviceUrl || !serviceInstanceId.success || !collectiveId.success) return { kind: 'invalid' };
  return {
    kind: 'target',
    target: { serviceUrl, serviceInstanceId: serviceInstanceId.data, collectiveId: collectiveId.data },
  };
}

function normalizeServiceOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
