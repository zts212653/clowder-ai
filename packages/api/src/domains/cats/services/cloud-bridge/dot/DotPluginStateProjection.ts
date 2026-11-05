import type {
  PluginManagerCatalogCandidate,
  PluginManagerProjectionOverrides,
} from '../../../../plugin/manager/plugin-manager-projection.js';
import type { DotConnectionService } from './DotConnectionService.js';

/** Business auth/setup facts decorate the existing Host inventory projection. */
export class DotPluginStateProjection {
  constructor(
    private readonly connection: () => DotConnectionService | undefined,
    private readonly verified: () => Promise<boolean>,
  ) {}
  async read(candidate: PluginManagerCatalogCandidate): Promise<PluginManagerProjectionOverrides> {
    if (candidate.pluginId !== 'official.chatgpt-dot') return {};
    try {
      const status = await this.connection()?.status();
      const authState =
        !status || !status.credentialActive || status.revoked
          ? 'disconnected'
          : status.subscription === 'expired'
            ? 'expired'
            : status.paired && status.subscription === 'active'
              ? 'connected'
              : 'pending';
      return { authState, configState: authState === 'connected' && (await this.verified()) ? 'ready' : 'incomplete' };
    } catch {
      return { authState: 'error', configState: 'invalid' };
    }
  }
}
