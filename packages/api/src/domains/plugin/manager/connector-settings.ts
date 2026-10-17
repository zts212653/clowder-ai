import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pluginAccessError, requirePluginOwnerLocalAccess } from '../../../routes/plugin-access-guards.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginPrivateStoragePort } from '../host-surface/plugin-private-storage.js';

// The retained connector command bridge already reads and CAS-writes this record.
// Owner settings use the same record, independently of adapter activation.
const KEY = 'connector.permissions.v1';
const identity = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim() === value, 'invalid identity');
const group = z.object({ externalChatId: identity, label: z.string().optional() }).strict();
const unique = (items: readonly string[]) => new Set(items).size === items.length;
const admins = z.array(identity).refine(unique, 'duplicate administrator');
const groups = z
  .array(group)
  .max(5000)
  .refine((items) => unique(items.map((item) => item.externalChatId)), 'duplicate group');
const storedGroup = group.extend({ addedAt: z.number().int().nonnegative().safe() });
const stored = z
  .object({
    v: z.literal(1),
    whitelistEnabled: z.boolean(),
    commandAdminOnly: z.boolean(),
    adminConfigured: z.boolean(),
    adminOpenIds: admins,
    allowedGroups: z
      .array(storedGroup)
      .refine((items) => unique(items.map((item) => item.externalChatId)), 'duplicate group'),
  })
  .refine((value) => value.adminConfigured || value.adminOpenIds.length === 0, 'invalid administrator state');
const edit = z
  .object({
    expectedRevision: z.number().int().positive().safe().nullable(),
    whitelistEnabled: z.boolean().optional(),
    commandAdminOnly: z.boolean().optional(),
    adminOpenIds: admins.optional(),
    allowedGroups: groups.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'no settings provided');
const defaults = {
  v: 1 as const,
  whitelistEnabled: false,
  commandAdminOnly: false,
  adminConfigured: false,
  adminOpenIds: [],
  allowedGroups: [],
};

export class ConnectorSettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function projection(revision: number | null, value: z.infer<typeof stored>) {
  return {
    revision,
    whitelistEnabled: value.whitelistEnabled,
    commandAdminOnly: value.commandAdminOnly,
    adminOpenIds: value.adminOpenIds,
    allowedGroups: value.allowedGroups,
  };
}

export class ConnectorSettingsService {
  constructor(
    private readonly options: {
      inventory: Pick<PluginInventoryStore, 'snapshot'>;
      storage?: Pick<PluginPrivateStoragePort, 'get' | 'compareAndSet'>;
      now?: () => number;
    },
  ) {}

  private async authority(pluginId: string, write: boolean) {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (item) => item.pluginId === pluginId && item.lifecycleState === 'installed',
    );
    const manifest = snapshot.packages.find((item) => item.packageDigest === instance?.packageDigest)?.manifest;
    const declaration = manifest && 'permissions' in manifest ? manifest.permissions : undefined;
    if (
      !instance ||
      !declaration ||
      typeof declaration !== 'object' ||
      !('label' in declaration) ||
      typeof declaration.label !== 'string'
    )
      throw new ConnectorSettingsError(404, 'Group settings are not declared by this installed plugin');
    const grant = snapshot.grants.find((item) => item.pluginInstanceId === instance.pluginInstanceId);
    const requested = new Set(manifest?.features.flatMap((feature) => feature.capabilities));
    const required = write ? (['plugin.state.get', 'plugin.state.set'] as const) : (['plugin.state.get'] as const);
    if (required.some((capability) => !requested.has(capability) || !grant?.effectiveGrants.includes(capability)))
      throw new ConnectorSettingsError(403, 'Group settings storage grant is unavailable');
    if (!this.options.storage) throw new ConnectorSettingsError(503, 'Group settings storage is unavailable');
    return {
      fence: JSON.stringify([
        instance.pluginInstanceId,
        instance.packageDigest,
        instance.lifecycleRevision,
        grant?.grantRevision,
      ]),
      storage: this.options.storage,
    };
  }

  private decode(value: unknown) {
    const parsed = stored.safeParse(value);
    if (!parsed.success) throw new ConnectorSettingsError(409, 'Stored group settings are invalid');
    return parsed.data;
  }

  async read(pluginId: string, assertRequestCurrent: () => void = () => {}) {
    assertRequestCurrent();
    const authority = await this.authority(pluginId, false);
    const entry = await authority.storage.get(pluginId, KEY);
    assertRequestCurrent();
    if ((await this.authority(pluginId, false)).fence !== authority.fence)
      throw new ConnectorSettingsError(409, 'Plugin changed; reload settings');
    return projection(entry?.revision ?? null, entry ? this.decode(entry.value) : defaults);
  }

  async save(pluginId: string, input: unknown, assertRequestCurrent: () => void = () => {}) {
    const parsed = edit.safeParse(input);
    if (!parsed.success)
      throw new ConnectorSettingsError(
        400,
        `Invalid group settings field: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
      );
    assertRequestCurrent();
    const authority = await this.authority(pluginId, true);
    const entry = await authority.storage.get(pluginId, KEY);
    const previous = entry ? this.decode(entry.value) : defaults;
    if ((entry?.revision ?? null) !== parsed.data.expectedRevision)
      throw new ConnectorSettingsError(409, 'Group settings changed; reload settings');
    const { expectedRevision, allowedGroups, adminOpenIds, ...flags } = parsed.data;
    const value = this.decode({
      ...previous,
      ...flags,
      ...(adminOpenIds ? { adminOpenIds, adminConfigured: true } : {}),
      ...(allowedGroups
        ? {
            allowedGroups: allowedGroups.map((item) => ({
              ...item,
              addedAt:
                previous.allowedGroups.find((old) => old.externalChatId === item.externalChatId)?.addedAt ??
                (this.options.now ?? Date.now)(),
            })),
          }
        : {}),
    });
    if (value.allowedGroups.length > 5000) throw new ConnectorSettingsError(400, 'Too many groups');
    assertRequestCurrent();
    if ((await this.authority(pluginId, true)).fence !== authority.fence)
      throw new ConnectorSettingsError(409, 'Plugin changed; reload settings');
    const result = await authority.storage.compareAndSet(pluginId, KEY, expectedRevision, value);
    if (!result.applied || result.revision === undefined)
      throw new ConnectorSettingsError(409, 'Group settings changed; reload settings');
    return projection(result.revision, value);
  }
}

export function registerConnectorSettingsRoutes(app: FastifyInstance, service: ConnectorSettingsService): void {
  for (const method of ['GET', 'PUT'] as const) {
    app.route<{ Params: { pluginId: string } }>({
      method,
      url: '/api/plugin-manager/plugins/:pluginId/permissions',
      handler: async (request, reply) => {
        const mode = method === 'GET' ? 'read' : 'write';
        const access = requirePluginOwnerLocalAccess(request, mode);
        if ('error' in access) return pluginAccessError(reply, access);
        const assertCurrent = () => {
          request.assertSessionCurrent?.();
          const current = requirePluginOwnerLocalAccess(request, mode);
          if (request.raw.aborted || 'error' in current || current.operator !== access.operator)
            throw new ConnectorSettingsError(403, 'Owner request is no longer current');
        };
        try {
          return method === 'GET'
            ? await service.read(request.params.pluginId, assertCurrent)
            : await service.save(request.params.pluginId, request.body, assertCurrent);
        } catch (error) {
          if (error instanceof ConnectorSettingsError) return reply.status(error.status).send({ error: error.message });
          throw error;
        }
      },
    });
  }
}

/** Only the original declarative group-settings label is projected into the owner UI. */
export function connectorPermissionsProjection(manifest: unknown): { permissions?: { label: string } } {
  if (!manifest || typeof manifest !== 'object' || !('permissions' in manifest)) return {};
  const declaration = manifest.permissions;
  return declaration &&
    typeof declaration === 'object' &&
    'label' in declaration &&
    typeof declaration.label === 'string'
    ? { permissions: { label: declaration.label } }
    : {};
}
