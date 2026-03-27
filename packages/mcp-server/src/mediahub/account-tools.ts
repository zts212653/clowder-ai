/**
 * MediaHub — Account Management MCP Tools
 * F139 Phase B: Credential binding, unbinding, health check.
 *
 * Tools: mediahub_bind_account, mediahub_unbind_account, mediahub_account_status
 */

import { z } from 'zod';
import type { ToolResult } from '../tools/file-tools.js';
import { errorResult, successResult } from '../tools/file-tools.js';
import type { AccountManager } from './account-manager.js';
import type { MediaProvider, ProviderRegistry } from './provider.js';
import type { HealthCheckResult } from './types.js';

// ============ Lazy references (set by bootstrap) ============

let accountRef: AccountManager | null = null;
let registryRef: ProviderRegistry | null = null;

/** Provider factory: providerId → (credentials → provider | null) */
type ProviderFactory = (data: Record<string, string>) => MediaProvider | null;
const providerFactories = new Map<string, ProviderFactory>();

export function setAccountRefs(manager: AccountManager, registry: ProviderRegistry): void {
  accountRef = manager;
  registryRef = registry;
}

/** Register a factory so bind_account can auto-activate providers at runtime */
export function registerProviderFactory(id: string, factory: ProviderFactory): void {
  providerFactories.set(id, factory);
}

/** Try to auto-load a provider from Redis credentials (lazy activation for Console-bound providers) */
export async function tryAutoLoadProvider(providerId: string): Promise<boolean> {
  if (!accountRef || !registryRef) return false;
  if (registryRef.get(providerId)) return true;

  const data = await accountRef.getCredentialData(providerId);
  if (!data) return false;

  const factory = providerFactories.get(providerId);
  if (!factory) return false;

  const provider = factory(data);
  if (!provider) return false;

  registryRef.register(provider);
  return true;
}

function getManager(): AccountManager {
  if (!accountRef) throw new Error('AccountManager not initialized');
  return accountRef;
}

function getRegistry(): ProviderRegistry {
  if (!registryRef) throw new Error('ProviderRegistry not initialized');
  return registryRef;
}

// ============ Required credential fields per provider ============

const REQUIRED_FIELDS: Record<string, string[]> = {
  kling: ['accessKey', 'secretKey'],
  jimeng: ['accessKey', 'secretKey'],
};

// ============ Tool: bind_account ============

export const bindAccountInputSchema = {
  provider: z.string().describe('Provider ID (e.g. "kling", "jimeng")'),
  credentials: z
    .record(z.string())
    .describe('Provider credentials object (e.g. { "accessKey": "...", "secretKey": "..." })'),
};

export async function handleBindAccount(args: {
  provider: string;
  credentials: Record<string, string>;
}): Promise<ToolResult> {
  try {
    const manager = getManager();
    const registry = getRegistry();

    // Validate required fields
    const required = REQUIRED_FIELDS[args.provider] ?? [];
    for (const field of required) {
      if (!args.credentials[field]) {
        return errorResult(`Missing required credential field "${field}" for provider "${args.provider}"`);
      }
    }

    await manager.saveCredential(args.provider, 'api_key', args.credentials);

    // Auto-activate: register provider if factory exists and not already registered
    let activated = false;
    if (!registry.get(args.provider)) {
      const factory = providerFactories.get(args.provider);
      if (factory) {
        const provider = factory(args.credentials);
        if (provider) {
          registry.register(provider);
          activated = true;
        }
      }
    }

    return successResult(
      JSON.stringify(
        {
          provider: args.provider,
          status: 'bound',
          activated,
          message: activated
            ? `Credentials saved and provider "${args.provider}" activated.`
            : `Credentials saved for "${args.provider}". Restart to activate if not already registered.`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: unbind_account ============

export const unbindAccountInputSchema = {
  provider: z.string().describe('Provider ID to unbind'),
};

export async function handleUnbindAccount(args: { provider: string }): Promise<ToolResult> {
  try {
    const manager = getManager();
    const registry = getRegistry();
    const removed = await manager.removeCredential(args.provider);
    if (!removed) return errorResult(`No credentials found for provider "${args.provider}"`);
    registry.unregister(args.provider);
    return successResult(`Credentials removed and provider "${args.provider}" unregistered.`);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: account_status ============

export const accountStatusInputSchema = {
  check_health: z.boolean().default(false).describe('If true, actively probe provider APIs to verify credentials'),
};

export async function handleAccountStatus(args: { check_health?: boolean }): Promise<ToolResult> {
  try {
    const manager = getManager();
    const registry = getRegistry();
    const credentials = await manager.listCredentials();

    if (credentials.length === 0) {
      return successResult('No bound accounts. Use mediahub_bind_account to save provider credentials.');
    }

    // If health check requested, probe each provider
    if (args.check_health) {
      for (const cred of credentials) {
        const provider = registry.get(cred.providerId) as
          | (MediaProvider & { checkHealth?(): Promise<HealthCheckResult> })
          | undefined;
        if (provider?.checkHealth) {
          const result = await provider.checkHealth();
          const status = result.healthy ? 'healthy' : 'error';
          await manager.updateHealthStatus(cred.providerId, status);
          cred.healthStatus = status;
          cred.lastHealthAt = Date.now();
        }
      }
    }

    const summary = credentials.map((c) => ({
      provider: c.providerId,
      type: c.credentialType,
      health: c.healthStatus,
      registered: !!registry.get(c.providerId),
      lastChecked: c.lastHealthAt > 0 ? new Date(c.lastHealthAt).toISOString() : 'never',
      boundAt: new Date(c.createdAt).toISOString(),
    }));

    return successResult(JSON.stringify(summary, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool Definitions Array ============

export const accountTools = [
  {
    name: 'mediahub_bind_account',
    description:
      'Save provider API credentials (BYOK mode). Encrypts and stores in Redis. ' +
      'Auto-activates the provider if possible. ' +
      'Required fields: kling/jimeng need accessKey + secretKey.',
    inputSchema: bindAccountInputSchema,
    handler: handleBindAccount,
  },
  {
    name: 'mediahub_unbind_account',
    description: 'Remove stored credentials and unregister a MediaHub provider.',
    inputSchema: unbindAccountInputSchema,
    handler: handleUnbindAccount,
  },
  {
    name: 'mediahub_account_status',
    description:
      'List bound MediaHub provider accounts with health status. ' +
      'Set check_health=true to actively probe provider APIs.',
    inputSchema: accountStatusInputSchema,
    handler: handleAccountStatus,
  },
] as const;
