import type {
  ILimbNode,
  LimbCapability,
  LimbCommandSchema,
  LimbInvocationContext,
  LimbInvokeResult,
  LimbNodeStatus,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { LimbDeclaration } from './limb-yaml-loader.js';
import { PluginRestExecutor } from './PluginRestExecutor.js';
import { PluginTokenManager } from './PluginTokenManager.js';

// ─── Handler types ──────────────────────────────────────────

export interface InvokeContext {
  pluginConfig: Record<string, string>;
  tokenManager: PluginTokenManager;
  /** Trusted server-derived callback provenance. Absent for legacy/direct invocations. */
  invocation?: LimbInvocationContext;
  /** Call another REST command defined in the same YAML */
  executeRest: (commandId: string, params: Record<string, unknown>) => Promise<LimbInvokeResult>;
}

export type InvokeHandler = (params: Record<string, unknown>, ctx: InvokeContext) => Promise<LimbInvokeResult>;

// ─── PluginLimbAdapter ──────────────────────────────────────

export interface PluginLimbAdapterConfig {
  declaration: LimbDeclaration;
  pluginConfig: Record<string, string>;
  redis?: RedisClient;
  handlers?: Record<string, InvokeHandler>;
}

/**
 * Generic plugin limb adapter — driven by YAML declaration.
 * Routes commands to REST executor or invoke handlers.
 */
export class PluginLimbAdapter implements ILimbNode {
  readonly nodeId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly capabilities: LimbCapability[];
  readonly commandSchemas: Readonly<Record<string, LimbCommandSchema>>;

  private readonly declaration: LimbDeclaration;
  private readonly pluginConfig: Record<string, string>;
  private readonly tokenManager: PluginTokenManager | undefined;
  private readonly restExecutor: PluginRestExecutor | undefined;
  private readonly handlers: Record<string, InvokeHandler>;

  constructor(config: PluginLimbAdapterConfig) {
    this.declaration = config.declaration;
    this.pluginConfig = config.pluginConfig;
    this.nodeId = config.declaration.nodeId;
    this.displayName = config.declaration.displayName;
    this.platform = config.declaration.platform;
    this.capabilities = config.declaration.capabilities;
    this.handlers = config.handlers ?? {};

    // Build command schemas from declaration — expose description + params only (no internal REST/handler details)
    const schemas: Record<string, LimbCommandSchema> = {};
    for (const [name, def] of Object.entries(config.declaration.commands)) {
      schemas[name] = { description: def.description, params: def.params };
    }
    this.commandSchemas = schemas;

    if (config.declaration.auth && config.declaration.baseUrl) {
      this.tokenManager = new PluginTokenManager(
        config.declaration.auth,
        config.declaration.baseUrl,
        config.pluginConfig,
        config.redis,
      );
      this.restExecutor = new PluginRestExecutor(
        config.declaration.baseUrl,
        this.tokenManager,
        config.declaration.error,
        config.declaration.auth.tokenPlacement,
        config.declaration.auth.tokenParamName,
      );
    }
  }

  async register(): Promise<void> {}
  async deregister(): Promise<void> {}

  async invoke(
    command: string,
    params: Record<string, unknown>,
    invocation?: LimbInvocationContext,
  ): Promise<LimbInvokeResult> {
    const commandDef = this.declaration.commands[command];
    if (!commandDef) {
      return { success: false, error: `Unknown command: ${command}` };
    }

    // Validate required params
    const missingParams = this.findMissingRequired(commandDef.params, params);
    if (missingParams.length > 0) {
      return { success: false, error: `Missing required params: ${missingParams.join(', ')}` };
    }

    try {
      if (commandDef.type === 'rest') {
        return await this.executeRestCommand(command, commandDef, params);
      }
      return await this.executeInvokeCommand(commandDef, params, invocation);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    const hasRequiredConfig = this.declaration.auth
      ? Object.values(this.declaration.auth.tokenParams).every((tmpl) => {
          const resolved = this.tokenManager?.resolveTemplate(tmpl);
          return resolved && resolved.length > 0;
        })
      : true;

    if (!hasRequiredConfig) return 'offline';

    if (this.tokenManager) {
      try {
        await this.tokenManager.getAccessToken();
        return 'online';
      } catch {
        return 'degraded';
      }
    }
    return 'online';
  }

  private async executeRestCommand(
    commandId: string,
    commandDef: (typeof this.declaration.commands)[string],
    params: Record<string, unknown>,
  ): Promise<LimbInvokeResult> {
    if (!this.restExecutor) {
      return { success: false, error: 'REST executor not configured (missing auth/baseUrl in YAML)' };
    }
    return this.restExecutor.execute(commandDef, params);
  }

  private async executeInvokeCommand(
    commandDef: (typeof this.declaration.commands)[string],
    params: Record<string, unknown>,
    invocation?: LimbInvocationContext,
  ): Promise<LimbInvokeResult> {
    if (!commandDef.handler) {
      return { success: false, error: 'Invoke command missing handler' };
    }

    // builtin handlers
    if (commandDef.handler === 'builtin:health_check') {
      const status = await this.healthCheck();
      return { success: true, data: { status: status === 'online' ? 'connected' : status } };
    }

    // plugin handlers: "plugin-id:handler_name"
    const handler = this.handlers[commandDef.handler];
    if (!handler) {
      return { success: false, error: `Handler not found: ${commandDef.handler}` };
    }

    const ctx: InvokeContext = {
      pluginConfig: this.pluginConfig,
      tokenManager: this.tokenManager!,
      ...(invocation ? { invocation } : {}),
      executeRest: (cmdId, p) => {
        const def = this.declaration.commands[cmdId];
        if (!def || def.type !== 'rest') {
          return Promise.resolve({ success: false, error: `REST command not found: ${cmdId}` });
        }
        return this.executeRestCommand(cmdId, def, p);
      },
    };
    return handler(params, ctx);
  }

  private findMissingRequired(
    paramDefs: Record<string, { required?: boolean; validation?: 'adapter' | 'handler' }>,
    params: Record<string, unknown>,
  ): string[] {
    return Object.entries(paramDefs)
      .filter(([key, def]) => def.required && def.validation !== 'handler' && params[key] === undefined)
      .map(([key]) => key);
  }
}
