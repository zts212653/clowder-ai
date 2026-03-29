/**
 * Config Store — hot-updatable configuration overlay (F4)
 *
 * Provides a runtime overlay on top of process.env for safe hot-reload
 * of select configuration keys without server restart.
 */

import { clearBudgetCache } from './cat-budgets.js';
import { configEventBus, createChangeSetId } from './config-event-bus.js';

export type ConfigSnapshotPath = readonly [string, ...string[]];

interface ConfigKeyDefinition {
  envKey: string;
  snapshotPath: ConfigSnapshotPath;
  validate(value: string): boolean;
  riskLevel: 'standard' | 'high';
}

const CONFIG_KEY_DEFINITIONS: Record<string, ConfigKeyDefinition> = {
  'cli.timeoutMs': {
    envKey: 'CLI_TIMEOUT_MS',
    snapshotPath: ['cli', 'timeoutMs'],
    validate: (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    riskLevel: 'standard',
  },
  'cli.codexSandboxMode': {
    envKey: 'CAT_CODEX_SANDBOX_MODE',
    snapshotPath: ['cli', 'codexSandboxMode'],
    validate: (value) => ['read-only', 'workspace-write', 'danger-full-access'].includes(value),
    riskLevel: 'high',
  },
  'cli.codexApprovalPolicy': {
    envKey: 'CAT_CODEX_APPROVAL_POLICY',
    snapshotPath: ['cli', 'codexApprovalPolicy'],
    validate: (value) => ['untrusted', 'on-failure', 'on-request', 'never'].includes(value),
    riskLevel: 'high',
  },
  'a2a.maxDepth': {
    envKey: 'MAX_A2A_DEPTH',
    snapshotPath: ['a2a', 'maxDepth'],
    validate: (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 10,
    riskLevel: 'standard',
  },
  'codex.execution.model': {
    envKey: 'CAT_CODEX_EXEC_MODEL',
    snapshotPath: ['codexExecution', 'model'],
    validate: (value) => value.trim().length > 0,
    riskLevel: 'high',
  },
  'codex.execution.authMode': {
    envKey: 'CODEX_AUTH_MODE',
    snapshotPath: ['codexExecution', 'authMode'],
    validate: (value) => ['oauth', 'api_key', 'auto'].includes(value),
    riskLevel: 'high',
  },
  'codex.execution.passModelArg': {
    envKey: 'CAT_CODEX_PASS_MODEL_ARG',
    snapshotPath: ['codexExecution', 'passModelArg'],
    validate: (value) => ['true', 'false'].includes(value),
    riskLevel: 'high',
  },
  'ui.bubble.thinking': {
    envKey: 'UI_BUBBLE_THINKING_DEFAULT',
    snapshotPath: ['ui', 'bubbleDefaults', 'thinking'],
    validate: (value) => ['expanded', 'collapsed'].includes(value),
    riskLevel: 'standard',
  },
  'ui.bubble.cliOutput': {
    envKey: 'UI_BUBBLE_CLI_OUTPUT_DEFAULT',
    snapshotPath: ['ui', 'bubbleDefaults', 'cliOutput'],
    validate: (value) => ['expanded', 'collapsed'].includes(value),
    riskLevel: 'standard',
  },
};

class ConfigStoreImpl {
  private overlay = new Map<string, string>();

  private definitionFor(key: string): ConfigKeyDefinition | undefined {
    return CONFIG_KEY_DEFINITIONS[key];
  }

  /** Set a hot-updatable config key. Throws if key is not updatable. */
  set(key: string, value: string | number | boolean): void {
    const definition = this.definitionFor(key);
    if (!definition) {
      throw new Error(
        `Key '${key}' is not hot-updatable. Updatable keys: ${Object.keys(CONFIG_KEY_DEFINITIONS).join(', ')}`,
      );
    }
    const normalized = String(value).trim();
    if (!definition.validate(normalized)) {
      throw new Error(`invalid value for key '${key}': ${normalized}`);
    }
    const oldValue = this.overlay.get(key) ?? process.env[definition.envKey];
    this.overlay.set(key, normalized);
    process.env[definition.envKey] = normalized;
    clearBudgetCache();
    if (normalized !== oldValue) {
      configEventBus.emitChange({
        source: 'config-store',
        scope: 'key',
        changedKeys: [definition.envKey],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
    }
  }

  /** Get a config key value (overlay first, then env). */
  get(key: string): string | undefined {
    const definition = this.definitionFor(key);
    if (!definition) return undefined;
    return this.overlay.get(key) ?? process.env[definition.envKey];
  }

  /** List all updatable keys and their current values. */
  listUpdatable(): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const key of Object.keys(CONFIG_KEY_DEFINITIONS)) {
      result[key] = this.get(key);
    }
    return result;
  }

  listUpdatableKeys(): string[] {
    return Object.keys(CONFIG_KEY_DEFINITIONS);
  }

  getSnapshotPath(key: string): ConfigSnapshotPath | undefined {
    return this.definitionFor(key)?.snapshotPath;
  }

  getRiskLevel(key: string): 'standard' | 'high' | undefined {
    return this.definitionFor(key)?.riskLevel;
  }

  isHighRiskKey(key: string): boolean {
    return this.definitionFor(key)?.riskLevel === 'high';
  }

  source(key: string): 'default' | 'env' | 'overlay' | undefined {
    const definition = this.definitionFor(key);
    if (!definition) return undefined;
    if (this.overlay.has(key)) return 'overlay';
    if (process.env[definition.envKey] != null && process.env[definition.envKey] !== '') return 'env';
    return 'default';
  }

  /** Reset overlay (for testing). */
  reset(): void {
    for (const [key] of this.overlay) {
      const definition = this.definitionFor(key);
      if (definition) delete process.env[definition.envKey];
    }
    this.overlay.clear();
    clearBudgetCache();
  }
}

export const configStore = new ConfigStoreImpl();
