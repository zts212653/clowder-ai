import type { BundledPluginRuntime } from '../../../../plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import type { DotConnectionService } from './DotConnectionService.js';

export class DotConnectionRuntime implements Pick<BundledPluginRuntime, 'start' | 'stop'> {
  constructor(
    private readonly connection: () => DotConnectionService | undefined,
    private readonly verified: () => Promise<boolean>,
  ) {}

  async start(_pluginInstanceId: string): Promise<void> {
    const status = await this.connection()?.status();
    if (
      !status?.credentialActive ||
      !status.paired ||
      status.subscription !== 'active' ||
      !status.replyAt ||
      !(await this.verified())
    ) {
      throw new Error('dot_round_trip_not_verified');
    }
  }

  async stop(_pluginInstanceId: string, _reason: string): Promise<void> {
    // Host activation intent gates new dispatches. A transport stop is not a provider cancellation.
  }
}
