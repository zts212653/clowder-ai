import type { PluginInventoryStore } from '../../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../../host-inventory/types.js';
import { withTargetAliasMutation } from './target-alias-mutation.js';

export interface AddressedPluginTarget {
  readonly kind: 'plugin';
  readonly id: string;
  readonly pluginId: string;
  readonly alias: string;
  readonly icon?: string;
  readonly displayName: string;
  readonly lifecycleRevision: number;
  readonly addressRevision: number;
}

export function normalizeTargetAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
}

export class PluginAddressError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function reservedAlias(alias: string): boolean {
  return (
    ['all', 'thread', '本帖', 'co-creator'].includes(alias) || alias.startsWith('全体') || alias.startsWith('all-')
  );
}

function eligible(instance: PluginInstanceRecord, pkg: PluginPackageRecord | undefined): boolean {
  return (
    instance.lifecycleState === 'installed' && pkg?.packageState === 'installed' && pkg.manifest?.call !== undefined
  );
}

function defaultAliasSource(instance: PluginInstanceRecord, pkg: PluginPackageRecord): string {
  return pkg.manifest?.call?.alias ?? instance.pluginId.split('.').at(-1) ?? 'plugin';
}

/** Inventory is the sole owner. Reads reconcile missing defaults in one transaction. */
export class PluginAddressedTargets {
  constructor(
    private readonly options: {
      inventory: PluginInventoryStore;
      memberAliases: () => readonly string[];
    },
  ) {}

  private async reconcile(): Promise<void> {
    const snapshot = await this.options.inventory.snapshot();
    if (
      !snapshot.instances.some(
        (i) =>
          !i.address &&
          eligible(
            i,
            snapshot.packages.find((p) => p.packageDigest === i.packageDigest),
          ),
      )
    )
      return;
    await withTargetAliasMutation(() =>
      this.options.inventory.transaction(async (tx) => {
        const used = new Set(this.options.memberAliases().map(normalizeTargetAlias));
        const instances = await tx.instances.list();
        for (const instance of instances) {
          used.add(normalizeTargetAlias(instance.pluginInstanceId));
          if (instance.lifecycleState === 'installed' && instance.address)
            used.add(normalizeTargetAlias(instance.address.alias));
        }
        for (const instance of instances) {
          const pkg = await tx.packages.get(instance.packageDigest);
          if (instance.address || !pkg || !eligible(instance, pkg)) continue;
          const raw = defaultAliasSource(instance, pkg);
          const cleaned =
            normalizeTargetAlias(raw)
              .replace(/[^\p{L}\p{N}_-]/gu, '-')
              .slice(0, 48) || 'plugin';
          const base = reservedAlias(cleaned) || !/^[\p{L}\p{N}]/u.test(cleaned) ? `plugin-${cleaned}` : cleaned;
          let alias = base;
          for (let n = 2; used.has(alias); n++) alias = `${base}-${n}`;
          used.add(alias);
          await tx.instances.put({ ...instance, address: { alias, revision: 1 } });
        }
      }),
    );
  }

  async list(includeDisabled = false): Promise<AddressedPluginTarget[]> {
    await this.reconcile();
    const snapshot = await this.options.inventory.snapshot();
    const members = new Set(this.options.memberAliases().map(normalizeTargetAlias));
    return snapshot.instances.flatMap((instance) => {
      const pkg = snapshot.packages.find((p) => p.packageDigest === instance.packageDigest);
      const call = pkg?.manifest?.call;
      if (
        !eligible(instance, pkg) ||
        !call ||
        !instance.address ||
        members.has(normalizeTargetAlias(instance.address.alias))
      )
        return [];
      if (!includeDisabled && instance.activationState !== 'enabled') return [];
      return [
        {
          kind: 'plugin' as const,
          id: instance.pluginInstanceId,
          pluginId: instance.pluginId,
          alias: instance.address.alias,
          ...(instance.address.icon ? { icon: instance.address.icon } : {}),
          displayName: call.displayName,
          lifecycleRevision: instance.lifecycleRevision,
          addressRevision: instance.address.revision,
        },
      ];
    });
  }

  /** Presentation of installed and retired addresses for existing queue/history rows. */
  async known() {
    await this.reconcile();
    const snapshot = await this.options.inventory.snapshot();
    return snapshot.instances.flatMap((instance) => {
      if (!instance.address) return [];
      const pkg = snapshot.packages.find((p) => p.packageDigest === instance.packageDigest);
      return [
        {
          kind: 'plugin' as const,
          id: instance.pluginInstanceId,
          pluginId: instance.pluginId,
          alias: instance.address.alias,
          icon: instance.address.icon,
          displayName: pkg?.manifest?.name ?? instance.pluginId,
          addressRevision: instance.address.revision,
          lifecycleRevision: instance.lifecycleRevision,
          installed: instance.lifecycleState === 'installed',
          enabled: eligible(instance, pkg) && instance.activationState === 'enabled',
        },
      ];
    });
  }

  async resolve(input: string): Promise<AddressedPluginTarget | undefined> {
    const targets = await this.list();
    // Exact identity wins. A queued identity is never reinterpreted as a new alias.
    return (
      targets.find((t) => t.id === input) ??
      targets.find((t) => normalizeTargetAlias(t.alias) === normalizeTargetAlias(input))
    );
  }

  async isInstanceId(id: string): Promise<boolean> {
    return (await this.options.inventory.snapshot()).instances.some((i) => i.pluginInstanceId === id);
  }

  async aliasInUse(alias: string, exceptInstance?: string, includeMembers = true): Promise<boolean> {
    await this.reconcile();
    const normalized = normalizeTargetAlias(alias);
    return (
      (includeMembers && this.options.memberAliases().some((a) => normalizeTargetAlias(a) === normalized)) ||
      (await this.options.inventory.snapshot()).instances.some(
        (i) =>
          i.pluginInstanceId !== exceptInstance &&
          [i.pluginInstanceId, i.lifecycleState === 'installed' ? i.address?.alias : undefined].some(
            (a) => a !== undefined && normalizeTargetAlias(a) === normalized,
          ),
      )
    );
  }

  async configure(id: string, input: { alias: string; icon?: string | null; expectedRevision: number }): Promise<void> {
    const alias = normalizeTargetAlias(input.alias);
    if (reservedAlias(alias)) throw new PluginAddressError('alias_reserved', 'Target alias is reserved');
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(alias))
      throw new PluginAddressError('alias_invalid', 'Invalid target alias');
    if (input.icon != null && !/^\/(?:uploads|avatars)\/[a-zA-Z0-9_./-]+$/.test(input.icon))
      throw new PluginAddressError('icon_invalid', 'Icon must be a Host avatar upload');
    if (input.icon?.includes('..')) throw new PluginAddressError('icon_invalid', 'Invalid target icon');
    await this.reconcile();
    await withTargetAliasMutation(() =>
      this.options.inventory.transaction(async (tx) => {
        const instance = await tx.instances.get(id);
        const pkg = instance ? await tx.packages.get(instance.packageDigest) : undefined;
        if (!instance || !eligible(instance, pkg))
          throw new PluginAddressError('not_addressable', 'Addressed plugin is not installed');
        if (instance.address?.revision !== input.expectedRevision)
          throw new PluginAddressError('stale_revision', 'Stale address revision');
        if (
          this.options.memberAliases().some((a) => normalizeTargetAlias(a) === alias) ||
          (await tx.instances.list()).some(
            (i) =>
              i.pluginInstanceId !== id &&
              [i.pluginInstanceId, i.lifecycleState === 'installed' ? i.address?.alias : undefined].some(
                (a) => a !== undefined && normalizeTargetAlias(a) === alias,
              ),
          )
        ) {
          throw new PluginAddressError('alias_taken', 'Target alias is already in use');
        }
        await tx.instances.put({
          ...instance,
          address: {
            alias,
            revision: input.expectedRevision + 1,
            ...(input.icon === undefined
              ? instance.address?.icon
                ? { icon: instance.address.icon }
                : {}
              : input.icon === null
                ? {}
                : { icon: input.icon }),
          },
          updatedAt: Date.now(),
        });
      }),
    );
  }
}
