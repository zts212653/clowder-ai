import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../carrier/plugin-call-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export interface PluginParticipant {
  readonly catId: string;
  readonly displayName: string;
  readonly nickname?: string;
  readonly variantLabel?: string;
  readonly defaultModel: string;
  readonly roleDescription?: string;
  readonly avatar?: string;
  /** Quota availability only; independent of provider routing or native policy support. */
  readonly available?: boolean;
  readonly supported: boolean;
}
export interface PluginParticipantRosterInput {
  readonly contributionId: string;
  /** Explicit opt-in keeps legacy strict participant schemas unchanged. */
  readonly includeAvailability?: true;
}
export interface PluginParticipantRosterHost {
  listForNativeContribution(input: PluginParticipantRosterInput): Promise<readonly PluginParticipant[]>;
}
/** Host dependencies, never exposed to a package. Capability is not invocation admission. */
export interface PluginParticipantRosterServices {
  listCats(): readonly Omit<PluginParticipant, 'supported' | 'available'>[];
  publicAvatar(value: string | undefined): Promise<string | undefined>;
  isCatAvailable(catId: string): boolean;
  supportsNativeAction(catId: string, policy: ToolExecutionPolicy): boolean;
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly ownerUserId: string | undefined;
  readonly manifest: PluginManifest;
  readonly effectiveGrants: readonly string[];
  readonly services: PluginParticipantRosterServices | undefined;
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}
function declaredScope(deps: Deps, input: PluginParticipantRosterInput) {
  const snapshot = snapshotPluginProtocolData(input);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
    throw new TypeError('Expected an input object');
  const value = snapshot as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== 'contributionId' && key !== 'includeAvailability') ||
    (Object.hasOwn(value, 'includeAvailability') && value.includeAvailability !== true) ||
    typeof value.contributionId !== 'string' ||
    !value.contributionId.length ||
    value.contributionId.length > 256 ||
    value.contributionId.trim() !== value.contributionId
  )
    throw new TypeError('Expected only contributionId');
  const contributions = deps.manifest.contributions?.filter((c) => c.id === value.contributionId) ?? [];
  const contribution = contributions[0];
  const feature = deps.manifest.features.find(
    (f) =>
      f.contributions?.some((c) => c.type === 'mcp' && c.id === value.contributionId) &&
      f.capabilities.every((c) => deps.effectiveGrants.includes(c)),
  );
  if (contributions.length !== 1 || contribution?.type !== 'mcp' || !contribution.actions?.length || !feature)
    refuse('An admitted native contribution with declared actions is required');
  return {
    contributionId: contribution.id,
    includeAvailability: value.includeAvailability === true,
    methods: contribution.actions.map((a) => a.method),
    capabilities: feature.capabilities,
  };
}
export function createPluginParticipantRosterHost(deps: Deps): PluginParticipantRosterHost {
  function principal() {
    const owner = currentPluginOwnerRequestContext(deps.pluginInstanceId);
    if (deps.ownerUserId && owner?.userId === deps.ownerUserId) return () => owner.assertCurrent();
    const native = currentPluginCallContext(deps.pluginInstanceId);
    if (
      deps.ownerUserId &&
      native?.userId === deps.ownerUserId &&
      native.invocationId &&
      native.assertInvocationCurrent
    ) {
      const check = native.assertInvocationCurrent;
      return () => check();
    }
    return refuse('Participant roster requires a current owner request or native invocation');
  }
  return Object.freeze({
    async listForNativeContribution(input: PluginParticipantRosterInput) {
      const { contributionId, methods, capabilities, includeAvailability } = declaredScope(deps, input);
      if (!deps.services)
        throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host participant roster unavailable');
      const services = deps.services;
      const callerCurrent = principal();
      async function current() {
        await callerCurrent();
        await deps.assertCurrent(capabilities);
        await callerCurrent();
      }
      await current();
      const policy: ToolExecutionPolicy = Object.freeze({
        mode: 'plugin_native',
        pluginInstanceId: deps.pluginInstanceId,
        contributionId,
        actionMethods: Object.freeze([...new Set(methods)].sort()),
      });
      // Snapshot only public fields before crossing any asynchronous boundary.
      const cats = services.listCats().map((cat) => ({
        catId: cat.catId,
        displayName: cat.displayName,
        defaultModel: cat.defaultModel,
        ...(cat.nickname === undefined ? {} : { nickname: cat.nickname }),
        ...(cat.variantLabel === undefined ? {} : { variantLabel: cat.variantLabel }),
        ...(cat.roleDescription === undefined ? {} : { roleDescription: cat.roleDescription }),
        avatar: cat.avatar,
      }));
      const rows: Omit<PluginParticipant, 'supported' | 'available'>[] = [];
      for (const cat of cats) {
        await current();
        const avatar = await services.publicAvatar(cat.avatar);
        await current();
        const { avatar: _privatePath, ...publicFields } = cat;
        rows.push(
          Object.freeze({
            ...publicFields,
            ...(avatar === undefined ? {} : { avatar }),
          }),
        );
      }
      await current();
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            ...row,
            ...(includeAvailability ? { available: services.isCatAvailable(row.catId) === true } : {}),
            supported: services.supportsNativeAction(row.catId, policy) === true,
          }),
        ),
      );
    },
  });
}
