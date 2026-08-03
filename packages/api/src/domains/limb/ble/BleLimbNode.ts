import type { ILimbNode, LimbCapability, LimbCommandSchema, LimbInvokeResult, LimbNodeStatus } from '@cat-cafe/shared';
import { buildBleCommandSchemas, buildBleLimbCapabilities } from './BleAdapters.js';
import type { BleBinding } from './BleBindingStore.js';

export interface BleLimbNodeExecutor {
  execute(binding: BleBinding, command: string): Promise<unknown>;
  nodeHealth(): LimbNodeStatus;
}

export class BleLimbNode implements ILimbNode {
  readonly nodeId: string;
  readonly displayName: string;
  readonly platform = 'macos-ble';
  readonly capabilities: LimbCapability[];
  readonly commandSchemas: Readonly<Record<string, LimbCommandSchema>>;

  constructor(
    private readonly binding: BleBinding,
    private readonly executor: BleLimbNodeExecutor,
  ) {
    this.nodeId = binding.nodeId;
    this.displayName = binding.displayName;
    this.capabilities = buildBleLimbCapabilities(binding.adapterId, binding.commands);
    this.commandSchemas = buildBleCommandSchemas(binding.adapterId, binding.commands);
  }

  async register(): Promise<void> {}

  async invoke(command: string, params: Record<string, unknown>): Promise<LimbInvokeResult> {
    if (!this.binding.commands.includes(command)) {
      return { success: false, error: `BLE command is not allowed by binding '${this.binding.bindingId}': ${command}` };
    }
    if (Object.keys(params).length > 0) {
      return { success: false, error: `BLE command '${command}' does not accept agent-supplied parameters` };
    }
    try {
      return { success: true, data: await this.executor.execute(this.binding, command) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    return this.executor.nodeHealth();
  }

  async deregister(): Promise<void> {}
}
