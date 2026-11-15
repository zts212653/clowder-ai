import { randomUUID } from 'node:crypto';
import {
  type CollectiveAccountabilityAttentionItem,
  type CollectiveProjectAttentionItem,
  collectiveAccountabilityAttentionItemSchema,
  collectiveProjectAttentionItemSchema,
  type UnifiedAttentionSourceRead,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { withOwnerOperationRequest } from '../domains/plugin/carrier/plugin-owner-operation-context.js';
import type { InstalledPluginOperations } from '../domains/plugin/operations/plugin-operation-routes.js';

const COVERAGE = 'pending_f290_collective_accountability_requests' as const;
const sourceSchema = z
  .object({
    projectRead: z
      .object({
        items: z.array(collectiveProjectAttentionItemSchema),
        reasons: z.array(z.string()),
        state: z
          .object({
            coverage: z.literal('pending_f290_project_materials_and_dates'),
            startedAt: z.number().int().nonnegative(),
            observedAt: z.number().int().nonnegative(),
            status: z.enum(['available', 'unavailable', 'unauthenticated', 'forbidden', 'invalid']),
            exhaustiveness: z.enum(['complete', 'partial', 'unknown']),
          })
          .strict(),
      })
      .strict()
      .optional(),
    items: z.array(collectiveAccountabilityAttentionItemSchema),
    reasons: z.array(z.string()),
    state: z
      .object({
        coverage: z.literal(COVERAGE),
        startedAt: z.number().int().nonnegative(),
        observedAt: z.number().int().nonnegative(),
        status: z.enum(['available', 'unavailable', 'unauthenticated', 'forbidden', 'invalid']),
        exhaustiveness: z.enum(['complete', 'partial', 'unknown']),
      })
      .strict(),
  })
  .strict();

export interface CollectiveAccountabilityAttentionSourceRead {
  readonly projectRead?: {
    items: CollectiveProjectAttentionItem[];
    reasons: string[];
    state: UnifiedAttentionSourceRead;
  };
  readonly items: CollectiveAccountabilityAttentionItem[];
  readonly state: UnifiedAttentionSourceRead;
  readonly reasons: string[];
}

const REMOTE_AUTHORITY_REASONS = new Set([
  'collective_accountability_connection_authority_unavailable',
  'collective_accountability_connection_read_failed',
  'collective_accountability_route_read_failed',
]);

function normalizeRemoteConnectionStatus(
  read: z.infer<typeof sourceSchema>,
): CollectiveAccountabilityAttentionSourceRead {
  if (
    read.state.status === 'unauthenticated' &&
    read.reasons.length > 0 &&
    read.reasons.every((reason) => REMOTE_AUTHORITY_REASONS.has(reason))
  ) {
    return {
      ...read,
      state: { ...read.state, status: 'unavailable' },
    };
  }
  return read;
}

function unavailableSource(
  startedAt: number,
  status: UnifiedAttentionSourceRead['status'] = 'unavailable',
): CollectiveAccountabilityAttentionSourceRead {
  return {
    items: [],
    reasons: ['collective_accountability_plugin_unavailable'],
    state: { coverage: COVERAGE, startedAt, observedAt: Date.now(), status, exhaustiveness: 'unknown' },
  };
}

function parseSourceResponse(
  response: Awaited<ReturnType<CollectiveAccountabilitySource>>,
  startedAt: number,
): CollectiveAccountabilityAttentionSourceRead {
  let status: UnifiedAttentionSourceRead['status'] = 'unavailable';
  if (response.status === 200) {
    const parsed = sourceSchema.safeParse(response.body.data);
    if (parsed.success) return normalizeRemoteConnectionStatus(parsed.data);
    status = 'invalid';
  } else if (response.status === 401) status = 'unauthenticated';
  else if (response.status === 403) status = 'forbidden';
  return unavailableSource(startedAt, status);
}

/** Dot consumes the installed package's owner action; connection discovery and authority stay with that owner. */
export async function readCollectiveAccountabilityAttentionSource(
  read: CollectiveAccountabilitySource | undefined,
  ownerUserId: string,
): Promise<CollectiveAccountabilityAttentionSourceRead> {
  const startedAt = Date.now();
  if (!read) return unavailableSource(startedAt);
  try {
    return parseSourceResponse(await read(ownerUserId), startedAt);
  } catch {
    // Failed installation, execution, or transport never means an empty complete inbox.
    return unavailableSource(startedAt);
  }
}

/** Omits the optional Collective attention source when uncomposed, uninstalled, or explicitly owner-disabled. */
export async function readOptionalCollectiveAccountabilityAttentionSource(
  read: CollectiveAccountabilitySource | undefined,
  ownerUserId: string,
): Promise<CollectiveAccountabilityAttentionSourceRead | undefined> {
  if (!read) return undefined;
  const startedAt = Date.now();
  try {
    const response = await read(ownerUserId);
    if (response.matched === false || response.disabled === true) return undefined;
    return parseSourceResponse(response, startedAt);
  } catch {
    return unavailableSource(startedAt);
  }
}

export type CollectiveAccountabilitySource = (userId: string) => Promise<{
  readonly matched?: boolean;
  readonly disabled?: boolean;
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}>;

/** Called only inside the Host's already-authorized Dot read. No HTTP identity or package-supplied owner. */
export function createCollectiveAccountabilitySource(
  operations: Pick<InstalledPluginOperations, 'runAction'>,
  ownerUserId: string,
): CollectiveAccountabilitySource {
  return async (userId) => {
    if (userId !== ownerUserId) return { status: 403, body: { error: 'Host owner required' } };
    const controller = new AbortController();
    const pluginId = 'official.collective-connector';
    const operationKey = 'accountability';
    const actionId = 'attention';
    try {
      return await withOwnerOperationRequest(
        {
          pluginId,
          operationKey,
          actionId,
          userId,
          requestId: randomUUID(),
          signal: controller.signal,
          assertCurrent: () => controller.signal.throwIfAborted(),
        },
        () => operations.runAction(pluginId, operationKey, actionId, {}),
      );
    } finally {
      controller.abort();
    }
  };
}
