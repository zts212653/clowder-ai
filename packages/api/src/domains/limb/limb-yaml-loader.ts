import { readFileSync } from 'node:fs';
import type { LimbCapability } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';

// ─── YAML Schema Types ─────────────────────────────────────

export interface LimbAuthConfig {
  type: 'client_credentials' | 'api_key' | 'bearer';
  tokenEndpoint: string;
  tokenParams: Record<string, string>;
  tokenResponsePath: string;
  tokenPlacement: 'query' | 'header';
  tokenParamName: string;
  tokenExpiredCodes: number[];
  ttlSeconds: number;
}

export interface LimbErrorConfig {
  codePath: string;
  messagePath: string;
}

export interface LimbCommandParam {
  type: string;
  required?: boolean;
  default?: unknown;
  desc?: string;
}

export interface LimbCommandDef {
  type: 'rest' | 'invoke';
  description: string;
  params: Record<string, LimbCommandParam>;
  // REST-specific
  endpoint?: string;
  method?: string;
  body?: unknown;
  contentType?: string;
  // invoke-specific
  handler?: string;
}

export interface LimbDeclaration {
  nodeId: string;
  displayName: string;
  platform: string;
  baseUrl?: string;
  auth?: LimbAuthConfig;
  error?: LimbErrorConfig;
  capabilities: LimbCapability[];
  commands: Record<string, LimbCommandDef>;
}

// ─── Loader ─────────────────────────────────────────────────

function parseAuth(raw: Record<string, unknown>): LimbAuthConfig {
  return {
    type: (raw['type'] as LimbAuthConfig['type']) ?? 'client_credentials',
    tokenEndpoint: raw['tokenEndpoint'] as string,
    tokenParams: (raw['tokenParams'] as Record<string, string>) ?? {},
    tokenResponsePath: (raw['tokenResponsePath'] as string) ?? 'access_token',
    tokenPlacement: (raw['tokenPlacement'] as 'query' | 'header') ?? 'query',
    tokenParamName: (raw['tokenParamName'] as string) ?? 'access_token',
    tokenExpiredCodes: (raw['tokenExpiredCodes'] as number[]) ?? [],
    ttlSeconds: (raw['ttlSeconds'] as number) ?? 7200,
  };
}

function parseCommand(raw: Record<string, unknown>): LimbCommandDef {
  return {
    type: (raw['type'] as 'rest' | 'invoke') ?? 'rest',
    description: (raw['description'] as string) ?? '',
    params: (raw['params'] as Record<string, LimbCommandParam>) ?? {},
    endpoint: raw['endpoint'] as string | undefined,
    method: raw['method'] as string | undefined,
    body: raw['body'],
    contentType: raw['contentType'] as string | undefined,
    handler: raw['handler'] as string | undefined,
  };
}

export function loadLimbDeclaration(yamlPath: string): LimbDeclaration {
  const raw = readFileSync(yamlPath, 'utf-8');
  const doc = parseYaml(raw) as Record<string, unknown>;

  const nodeId = doc['nodeId'] as string;
  const displayName = doc['displayName'] as string;
  const platform = doc['platform'] as string;
  const capabilities = doc['capabilities'] as LimbCapability[];

  if (!nodeId || !displayName || !platform || !Array.isArray(capabilities)) {
    throw new Error(`Invalid limb declaration in ${yamlPath}: missing required fields`);
  }

  const rawCommands = (doc['commands'] ?? {}) as Record<string, Record<string, unknown>>;
  const commands: Record<string, LimbCommandDef> = {};
  for (const [name, cmdRaw] of Object.entries(rawCommands)) {
    commands[name] = parseCommand(cmdRaw);
  }

  return {
    nodeId,
    displayName,
    platform,
    baseUrl: doc['baseUrl'] as string | undefined,
    auth: doc['auth'] ? parseAuth(doc['auth'] as Record<string, unknown>) : undefined,
    error: doc['error'] as LimbErrorConfig | undefined,
    capabilities,
    commands,
  };
}
