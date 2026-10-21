import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

/** The existing Host member directory, without plugin-specific binding or selection. */
export interface PluginMember {
  readonly catId: string;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly nickname?: string;
  readonly variantLabel?: string;
  readonly roleDescription?: string;
  readonly avatar?: string;
  readonly available: boolean;
}
export interface PluginMembersHost {
  list(): Promise<readonly PluginMember[]>;
  get(id: string): Promise<PluginMember | null>;
}
export interface PluginMembersServices {
  listCats(): readonly Omit<PluginMember, 'available'>[];
  publicAvatar(value: string | undefined): Promise<string | undefined>;
  isCatAvailable(catId: string): boolean;
}
export function createPluginMembersHost(deps: {
  readonly services: PluginMembersServices | undefined;
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}): PluginMembersHost {
  async function read(id?: string): Promise<readonly PluginMember[]> {
    await deps.assertCurrent(['thread.listMetadata']);
    const services = deps.services;
    if (!services) throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host member directory unavailable');
    const rows = services.listCats().filter((row) => id === undefined || row.catId === id);
    const result = await Promise.all(
      rows.map(async (row) => {
        const avatar = await services.publicAvatar(row.avatar);
        return {
          catId: row.catId,
          displayName: row.displayName,
          defaultModel: row.defaultModel,
          ...(row.nickname === undefined ? {} : { nickname: row.nickname }),
          ...(row.variantLabel === undefined ? {} : { variantLabel: row.variantLabel }),
          ...(row.roleDescription === undefined ? {} : { roleDescription: row.roleDescription }),
          ...(avatar === undefined ? {} : { avatar }),
          available: services.isCatAvailable(row.catId),
        };
      }),
    );
    await deps.assertCurrent(['thread.listMetadata']);
    return result;
  }
  return {
    list: () => read(),
    async get(id) {
      if (typeof id !== 'string' || !id || id.trim() !== id) throw new TypeError('Member id is required');
      return (await read(id))[0] ?? null;
    },
  };
}
