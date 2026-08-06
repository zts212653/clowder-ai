import { bindMcpImplementation, defineMcpTool, defineMigrationCandidateMcpTool } from './tool-governance.js';
import type {
  McpActionBoundary,
  McpMigrationCandidateInput,
  McpRuntimeProfile,
  NonEmptyReadonlyArray,
} from './tool-governance-types.js';

export type MigrationAuthority =
  | 'callback-owner'
  | 'callback-owner-private'
  | 'callback-thread'
  | 'callback-limb'
  | 'assigned-callback'
  | 'guardian-callback'
  | 'eval-callback'
  | 'eval-lifecycle-callback'
  | 'local-runtime'
  | 'provider-runtime';

export type McpMigrationSeed = {
  implementationExport: string;
  resourceFamily?: string;
  action: string;
  authority?: MigrationAuthority;
  risk: McpActionBoundary['risk'];
  runtimeProfiles: NonEmptyReadonlyArray<McpRuntimeProfile>;
  targetExposure?: 'profile-gated' | 'lazy-discoverable';
};

type LegacyToolFields = Pick<McpMigrationCandidateInput, 'name' | 'description' | 'inputSchema' | 'handler'>;

type MigrationFactoryDefaults = { resourceFamily?: string; authority?: MigrationAuthority };

function resolveMigrationGovernance(
  sourceFile: string,
  implementationModule: string | undefined,
  defaults: MigrationFactoryDefaults,
  input: LegacyToolFields & { governance: McpMigrationSeed },
): McpMigrationCandidateInput['governance'] {
  const sourceRef = `file:packages/mcp-server/src/tools/${sourceFile}` as const;
  const defaultModule = implementationModule ?? `./tools/${sourceFile.replace(/\.ts$/, '.js')}`;
  const resourceFamily = input.governance.resourceFamily ?? defaults.resourceFamily;
  const authority = input.governance.authority ?? defaults.authority;
  if (!resourceFamily || !authority) {
    throw new Error(`Incomplete MCP migration governance for ${input.name}`);
  }
  return {
    sourceRef,
    verificationRef: 'test:packages/mcp-server/test/tool-registration.test.js',
    implementationRef: `module:${defaultModule}#${input.governance.implementationExport}`,
    resourceFamily,
    action: input.governance.action,
    boundary: {
      authorizationPaths: deriveAuthorizationPaths(
        authority,
        resourceFamily,
        input.governance.runtimeProfiles,
        sourceRef,
      ),
      risk: input.governance.risk,
    },
    runtimeProfiles: input.governance.runtimeProfiles,
    ...(input.governance.targetExposure ? { targetExposure: input.governance.targetExposure } : {}),
  };
}

function callbackScope(
  authority: MigrationAuthority,
  resourceFamily: string,
): McpActionBoundary['authorizationPaths'][number]['scope'] {
  if (authority === 'callback-thread') return { kind: 'thread', threadRef: 'current-or-explicit-thread' };
  if (authority === 'callback-owner-private') return { kind: 'owner-private' };
  if (authority === 'assigned-callback') return { kind: 'assigned-subject', subjectRef: resourceFamily };
  return { kind: 'owner', resourceRef: resourceFamily };
}

function callbackPrincipal(
  authority: MigrationAuthority,
): 'invocation-cat' | 'assigned-cat' | 'guardian-cat' | 'eval-cat' {
  if (authority === 'assigned-callback' || authority === 'eval-lifecycle-callback') return 'assigned-cat';
  if (authority === 'guardian-callback') return 'guardian-cat';
  if (authority === 'eval-callback') return 'eval-cat';
  return 'invocation-cat';
}

function deriveAuthorizationPaths(
  authority: MigrationAuthority,
  resourceFamily: string,
  runtimeProfiles: readonly McpRuntimeProfile[],
  enforcementRef: `file:${string}`,
): McpActionBoundary['authorizationPaths'] {
  if (authority === 'local-runtime') {
    return [
      {
        principal: 'local-operator',
        credentialSource: 'local-process',
        scope: { kind: 'local-runtime' },
        enforcementRef,
      },
    ];
  }
  if (authority === 'provider-runtime') {
    return [
      {
        principal: 'provider-runtime',
        credentialSource: 'provider-credential',
        scope: { kind: 'global-governed' },
        enforcementRef,
      },
    ];
  }
  const scope = callbackScope(authority, resourceFamily);
  const primary: McpActionBoundary['authorizationPaths'][number] = {
    principal: callbackPrincipal(authority),
    credentialSource: authority.includes('-callback') ? 'callback-principal' : 'invocation-record',
    scope,
    enforcementRef,
  };
  const additional: McpActionBoundary['authorizationPaths'][number][] = [];
  if (authority === 'eval-lifecycle-callback') {
    additional.push({ principal: 'eval-cat', credentialSource: 'callback-principal', scope, enforcementRef });
  }
  if (runtimeProfiles.includes('agent-key') || authority === 'callback-limb') {
    additional.push({ principal: 'agent-key-cat', credentialSource: 'agent-key', scope, enforcementRef });
  }
  return [primary, ...additional];
}

export function defineMcpMigrationFactory(
  sourceFile: string,
  implementationModule?: string,
  defaults: MigrationFactoryDefaults = {},
) {
  return (input: LegacyToolFields & { governance: McpMigrationSeed }) => {
    return defineMigrationCandidateMcpTool({
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
      handler: input.handler,
      governance: resolveMigrationGovernance(sourceFile, implementationModule, defaults, input),
    });
  };
}

/** Promote an existing protected-base identity when its public contract intentionally changes. */
export function defineMcpCanonicalFactory(
  sourceFile: string,
  implementationModule?: string,
  defaults: MigrationFactoryDefaults = {},
) {
  return (input: LegacyToolFields & { governance: McpMigrationSeed }) => {
    const governance = resolveMigrationGovernance(sourceFile, implementationModule, defaults, input);
    return defineMcpTool({
      name: input.name,
      description: input.description,
      operation: {
        kind: 'single',
        action: governance.action,
        inputSchema: input.inputSchema,
        boundary: governance.boundary,
      },
      implementation: bindMcpImplementation(governance.implementationRef, input.handler),
      policy: {
        resourceFamily: governance.resourceFamily,
        exposureTier: {
          current: 'eager-core',
          ...(governance.targetExposure ? { target: governance.targetExposure } : {}),
          evidenceRef: governance.sourceRef,
        },
        runtimeProfiles: governance.runtimeProfiles,
        owner: {
          domainCell: 'architecture-cell:mcp-surface-governance',
          surface: 'mcp-surface-governance',
        },
        standaloneReason: {
          disposition: 'consolidation-candidate',
          kind: 'same-resource-lifecycle',
          evidenceRef: governance.sourceRef,
        },
        activeState: 'canonical',
        cognitiveEntryPoints: [{ kind: 'tool-description', ref: governance.sourceRef }],
        verification: [{ kind: 'test', ref: governance.verificationRef }],
      },
    });
  };
}
