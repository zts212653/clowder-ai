/**
 * @fileoverview Codex network environment derivation for enterprise proxy compatibility.
 *
 * Issue #1666: Windows enterprise proxy environments may route localhost/127.0.0.1 requests
 * through the proxy, causing 504 errors when Codex tries to reach a local provider gateway.
 *
 * This module provides pure functions to derive Codex launch environment with loopback
 * addresses added to NO_PROXY, while preserving existing proxy configuration and internal
 * network exceptions.
 */

/**
 * Loopback addresses that should bypass proxy for local provider gateways.
 */
const LOOPBACK_ADDRESSES = ['localhost', '127.0.0.1', '::1'] as const;

/**
 * System proxy exception sources for diagnostics.
 */
export type ProxyExceptionSource = 'env' | 'system_static' | 'system_pac' | 'none' | 'read_failed';

/**
 * Diagnostic information for network environment derivation.
 */
export interface CodexNetworkDiagnostic {
  /** Whether any proxy environment variables are present */
  readonly hasProxy: boolean;
  /** Source of proxy exceptions used */
  readonly exceptionSource: ProxyExceptionSource;
  /** Whether loopback addresses were added */
  readonly loopbackAdded: boolean;
  /** Scenarios not covered by this implementation (empty if fully handled) */
  readonly unsupportedScenarios: readonly string[];
}

/**
 * Derived network environment for Codex launch.
 */
export interface CodexNetworkEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly diagnostic: CodexNetworkDiagnostic;
}

/**
 * Windows system proxy configuration (read-only).
 */
export interface WindowsSystemProxyConfig {
  readonly enabled: boolean;
  readonly proxyServer?: string;
  readonly proxyOverride?: string;
  readonly hasPac: boolean;
}

/**
 * Options for reading Windows system proxy configuration.
 */
export interface ReadWindowsProxyOptions {
  readonly timeoutMs?: number;
}

/**
 * Derives Codex network environment from base environment.
 *
 * @param baseEnv - Base environment (already merged with account overrides and null deletions)
 * @param systemProxy - Pre-read Windows system proxy config (undefined = not read, null = read failed)
 * @returns Derived environment with loopback addresses in NO_PROXY
 */
export function deriveCodexNetworkEnvironmentSync(
  baseEnv: NodeJS.ProcessEnv,
  systemProxy?: WindowsSystemProxyConfig | null,
): CodexNetworkEnvironment {
  const env = { ...baseEnv };
  const diagnostic: CodexNetworkDiagnostic = {
    hasProxy: hasProxyEnv(env),
    exceptionSource: 'none',
    loopbackAdded: false,
    unsupportedScenarios: [],
  };

  // Collect existing exceptions from all case variants
  const existingExceptions = collectAllExceptions(env);

  if (existingExceptions.length > 0) {
    // User has explicit env exceptions - preserve and append
    const merged = mergeExceptions(existingExceptions, LOOPBACK_ADDRESSES);
    setNormalizedNoProxy(env, merged);
    return {
      env,
      diagnostic: {
        ...diagnostic,
        exceptionSource: 'env',
        loopbackAdded: merged.length > existingExceptions.length,
      },
    };
  }

  // No env exceptions - check Windows system proxy if applicable
  if (process.platform === 'win32') {
    if (systemProxy === undefined) {
      // Not read - cannot safely determine if system exceptions exist
      return {
        env,
        diagnostic: {
          ...diagnostic,
          unsupportedScenarios: ['windows_system_proxy_not_read'],
        },
      };
    }

    if (systemProxy === null) {
      // Read failed - preserve original environment
      return {
        env,
        diagnostic: {
          ...diagnostic,
          exceptionSource: 'read_failed',
          unsupportedScenarios: ['windows_system_proxy_read_failed'],
        },
      };
    }

    // Check PAC/WPAD first - independent of manual proxy enabled state
    if (systemProxy.hasPac) {
      // PAC/WPAD present - cannot safely convert to static list
      return {
        env,
        diagnostic: {
          ...diagnostic,
          exceptionSource: 'system_pac',
          unsupportedScenarios: ['windows_pac_wpad_not_convertible'],
        },
      };
    }

    if (!systemProxy.enabled) {
      // Manual proxy is disabled and no PAC - safe to add loopback only
      setNormalizedNoProxy(env, [...LOOPBACK_ADDRESSES]);
      return {
        env,
        diagnostic: {
          ...diagnostic,
          loopbackAdded: true,
        },
      };
    }

    // Manual proxy is enabled - check ProxyOverride

    if (systemProxy.proxyOverride) {
      // Parse ProxyOverride and merge with loopback
      const systemExceptions = parseWindowsProxyOverride(systemProxy.proxyOverride);
      if (systemExceptions.unsupported.length > 0) {
        // Contains patterns we cannot safely convert
        return {
          env,
          diagnostic: {
            ...diagnostic,
            exceptionSource: 'system_static',
            unsupportedScenarios: systemExceptions.unsupported.map(
              (pattern) => `windows_proxy_override_pattern_not_supported:${pattern}`,
            ),
          },
        };
      }

      // Safe to merge
      const merged = mergeExceptions(systemExceptions.supported, LOOPBACK_ADDRESSES);
      setNormalizedNoProxy(env, merged);
      return {
        env,
        diagnostic: {
          ...diagnostic,
          exceptionSource: 'system_static',
          loopbackAdded: merged.length > systemExceptions.supported.length,
        },
      };
    }
  }

  // Safe to add loopback-only exceptions
  setNormalizedNoProxy(env, [...LOOPBACK_ADDRESSES]);
  return {
    env,
    diagnostic: {
      ...diagnostic,
      loopbackAdded: true,
    },
  };
}

/**
 * Checks if environment has proxy configuration.
 */
function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return !!(env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy);
}

/**
 * Collects existing NO_PROXY entries from all case variants.
 * Returns deduplicated list preserving original casing.
 */
function collectAllExceptions(env: NodeJS.ProcessEnv): string[] {
  const all: string[] = [];
  const seen = new Set<string>();

  // Scan all environment keys for NO_PROXY variants (case-insensitive)
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== 'NO_PROXY') continue;

    const value = env[key];
    if (!value || value.trim() === '') continue;

    for (const entry of value.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const lower = trimmed.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        all.push(trimmed);
      }
    }
  }

  return all;
}

/**
 * Merges exception lists, deduplicating case-insensitively.
 */
function mergeExceptions(existing: readonly string[], toAdd: readonly string[]): string[] {
  const normalized = new Set(existing.map((s) => s.toLowerCase()));
  const result = [...existing];

  for (const addr of toAdd) {
    if (!normalized.has(addr.toLowerCase())) {
      result.push(addr);
      normalized.add(addr.toLowerCase());
    }
  }

  return result;
}

/**
 * Sets NO_PROXY in environment with platform-appropriate casing.
 * Removes all case variants and sets single canonical key.
 *
 * Windows: Always use uppercase NO_PROXY
 * Unix: Prefer existing standard key (NO_PROXY or no_proxy), otherwise use lowercase no_proxy
 *       Mixed-case variants (e.g. No_Proxy) are normalized to standard keys for matcher compatibility
 */
function setNormalizedNoProxy(env: NodeJS.ProcessEnv, exceptions: readonly string[]): void {
  const value = exceptions.join(',');

  // Detect existing standard casing on Unix
  let existingKey: string | undefined;
  if (process.platform !== 'win32') {
    // Only preserve standard keys that actual matchers recognize (NO_PROXY, no_proxy)
    // Mixed-case variants (No_Proxy, etc.) are not recognized by hyper-util and similar libraries
    for (const key of Object.keys(env)) {
      if (key === 'NO_PROXY' || key === 'no_proxy') {
        existingKey = key;
        break;
      }
    }
  }

  // Remove all case variants (scan all keys)
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NO_PROXY') {
      delete env[key];
    }
  }

  if (process.platform === 'win32') {
    // Windows: use uppercase only
    env.NO_PROXY = value;
  } else {
    // Unix: preserve existing standard key (NO_PROXY or no_proxy), default to lowercase
    env[existingKey || 'no_proxy'] = value;
  }
}

/**
 * Parses Windows ProxyOverride registry value.
 */
function parseWindowsProxyOverride(override: string): {
  supported: string[];
  unsupported: string[];
} {
  const supported: string[] = [];
  const unsupported: string[] = [];

  const entries = override
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const entry of entries) {
    if (entry === '<local>' || entry.includes('*') || entry.includes('-') || entry.includes('/')) {
      unsupported.push(entry);
    } else {
      supported.push(entry);
    }
  }

  return { supported, unsupported };
}

/**
 * Reads Windows WPAD state using WinHTTP API via PowerShell.
 *
 * Returns an object with:
 * - autoDetect: true (enabled) | false (disabled) | null (unknown)
 * - autoConfigUrl: string | null (explicit PAC URL from current connection)
 */
async function readWindowsWpadState(
  options?: ReadWindowsProxyOptions,
): Promise<{ autoDetect: boolean | null; autoConfigUrl: string | null } | null> {
  if (process.platform !== 'win32') return null;

  const timeoutMs = options?.timeoutMs ?? 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const execFileAsync = promisify(execFile);

    // Script is at packages/api/scripts/read-windows-wpad-state.ps1
    // This module is at packages/api/src/utils or packages/api/dist/utils
    const currentDir = dirname(fileURLToPath(import.meta.url));

    // Try source layout first (src/utils -> ../../scripts)
    let scriptPath = join(currentDir, '../../scripts/read-windows-wpad-state.ps1');

    // If not found, try dist layout (dist/utils -> ../../scripts)
    // Both resolve to packages/api/scripts from their respective locations
    if (!existsSync(scriptPath)) {
      scriptPath = join(currentDir, '../../../scripts/read-windows-wpad-state.ps1');
    }

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        signal: controller.signal,
        timeout: timeoutMs,
      },
    );

    const result = JSON.parse(stdout.trim());

    if (result.error) {
      // WinHTTP API call failed
      return null;
    }

    // Strict boolean check: only true/false are valid, everything else is unknown
    const autoDetect = result.autoDetect === true ? true : result.autoDetect === false ? false : null;

    // Extract autoConfigUrl from current connection (not registry root key)
    const autoConfigUrl =
      typeof result.autoConfigUrl === 'string' && result.autoConfigUrl ? result.autoConfigUrl : null;

    return { autoDetect, autoConfigUrl };
  } catch {
    // Timeout, permission denied, JSON parse error, script not found, etc.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads Windows system proxy configuration from registry (async).
 *
 * Reads the entire Internet Settings key at once. Only returns a valid config
 * if the entire read succeeds. Any failure (timeout, permission denied, etc.)
 * returns null to preserve the original environment.
 *
 * Exit code 1 from reg query means "command failed" - could be access denied,
 * key not found, or other errors. We cannot distinguish "value missing" from
 * "permission denied" reliably, so any failure returns null.
 */
export async function readWindowsSystemProxy(
  options?: ReadWindowsProxyOptions,
): Promise<WindowsSystemProxyConfig | null> {
  if (process.platform !== 'win32') return null;

  const timeoutMs = options?.timeoutMs ?? 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const keyPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

    // Read entire key at once. If this fails (access denied, timeout, etc.), return null.
    const { stdout } = await execFileAsync('reg', ['query', keyPath], {
      signal: controller.signal,
      timeout: timeoutMs,
    });

    // Parse all values from the complete output
    const proxyEnable = extractRegValue(stdout, 'ProxyEnable');
    const proxyServer = extractRegValue(stdout, 'ProxyServer');
    const proxyOverride = extractRegValue(stdout, 'ProxyOverride');
    const autoConfigURL = extractRegValue(stdout, 'AutoConfigURL');

    // ProxyEnable: REG_DWORD 0 or 1
    const enabled = proxyEnable === '0x1' || proxyEnable === '1';

    // Read WPAD state using WinHTTP API (current active connection)
    const wpadState = await readWindowsWpadState(options);

    // Three-state handling for WPAD:
    // - autoDetect=true: WPAD enabled, cannot convert to static proxy
    // - autoDetect=false: WPAD disabled, check explicit PAC
    // - autoDetect=null or wpadState=null: Cannot determine, preserve environment

    if (wpadState === null || wpadState.autoDetect === null) {
      // Cannot determine WPAD state (timeout, permission denied, API failure, invalid format)
      // Return null to trigger read_failed diagnostic
      return null;
    }

    // Check explicit PAC URL from both current connection and registry root key
    const connectionPacUrl = wpadState.autoConfigUrl; // From WinHTTP current connection
    const registryPacUrl = autoConfigURL; // From registry root key

    // Known not convertible: WPAD enabled OR explicit PAC URL configured
    const hasPac = wpadState.autoDetect === true || !!(connectionPacUrl || registryPacUrl);

    // Return config with hasPac=true to trigger windows_pac_wpad_not_convertible diagnostic
    // or hasPac=false when both WPAD and PAC are disabled
    return {
      enabled,
      proxyServer: enabled ? proxyServer : undefined,
      proxyOverride: enabled ? proxyOverride : undefined,
      hasPac,
    };
  } catch {
    // Any failure: timeout, access denied, key not found, etc.
    // Cannot safely determine system proxy state - return null to preserve environment.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractRegValue(stdout: string, valueName: string): string | undefined {
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(valueName)) {
      const parts = trimmed.split(/\s+/);
      // Registry values can be REG_SZ, REG_DWORD, REG_EXPAND_SZ, etc.
      const regTypes = ['REG_SZ', 'REG_DWORD', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BINARY'];
      let valueIndex = -1;
      for (const regType of regTypes) {
        const idx = parts.indexOf(regType);
        if (idx >= 0) {
          valueIndex = idx + 1;
          break;
        }
      }
      if (valueIndex > 0 && valueIndex < parts.length) {
        return parts.slice(valueIndex).join(' ').trim();
      }
    }
  }
  return undefined;
}
