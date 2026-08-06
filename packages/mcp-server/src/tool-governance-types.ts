export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type EvidenceRef =
  | `file:${string}`
  | `test:${string}`
  | `adr:${number}`
  | `message:${string}`
  | `architecture-cell:${string}`;

export type McpRisk = { level: 'read' | 'write' | 'destructive'; openWorld: boolean };

export type McpAuthorizationPath = {
  principal:
    | 'invocation-cat'
    | 'agent-key-cat'
    | 'assigned-cat'
    | 'guardian-cat'
    | 'eval-cat'
    | 'cvo'
    | 'local-operator'
    | 'provider-runtime';
  credentialSource:
    | 'invocation-record'
    | 'callback-principal'
    | 'agent-key'
    | 'assignment-record'
    | 'approval-record'
    | 'local-process'
    | 'provider-credential';
  scope:
    | { kind: 'owner'; resourceRef: string }
    | { kind: 'assigned-subject'; subjectRef: string }
    | { kind: 'thread'; threadRef: string }
    | { kind: 'owner-private' }
    | { kind: 'global-governed' }
    | { kind: 'local-runtime' };
  enforcementRef: EvidenceRef;
};

export type McpActionBoundary = {
  authorizationPaths: NonEmptyReadonlyArray<McpAuthorizationPath>;
  risk: McpRisk;
};

export type McpOperationContract =
  | {
      kind: 'single';
      action: string;
      inputSchema: Record<string, unknown>;
      boundary: McpActionBoundary;
      customDiscriminators?: readonly string[];
    }
  | {
      kind: 'discriminated';
      discriminator: string;
      variants: NonEmptyReadonlyArray<{
        action: string;
        inputSchema: Record<string, unknown>;
        boundary: McpActionBoundary;
      }>;
    };

export type McpRuntimeProfile = 'full' | 'readonly' | 'agent-key' | 'desktop:fable-phase0' | 'desktop:cloud-pro-phase0';

export type McpStandaloneReason =
  | {
      disposition: 'accepted-boundary';
      kind:
        | 'resource-entry'
        | 'authority-boundary'
        | 'destructive-boundary'
        | 'side-effect-boundary'
        | 'progressive-disclosure'
        | 'mode-matrix-boundary'
        | 'provider-transport-boundary';
      admissionRef: EvidenceRef;
    }
  | {
      disposition: 'consolidation-candidate';
      kind: 'same-resource-lifecycle';
      evidenceRef: EvidenceRef;
    };

export type ResolvedAdmissionClaim = {
  ref: EvidenceRef;
  subject: {
    toolName: string;
    resourceFamily: string;
    boundaryKind: Extract<McpStandaloneReason, { disposition: 'accepted-boundary' }>['kind'];
  };
  decision: 'accepted';
  sourceDigest: string;
};

export type ResolvedEvidenceCatalog = Readonly<{
  existingRefs: ReadonlySet<EvidenceRef>;
  admissionClaims: ReadonlyMap<EvidenceRef, NonEmptyReadonlyArray<ResolvedAdmissionClaim>>;
}>;

export const implementationBindingBrand: unique symbol = Symbol('McpImplementationBinding');

export type McpImplementationBinding = {
  ref: `module:${string}#${string}`;
  run: (args: never) => Promise<unknown>;
  readonly [implementationBindingBrand]: true;
};

export type ResolvedImplementationCatalog = ReadonlyMap<
  McpImplementationBinding['ref'],
  { moduleDigest: string; exportName: string; compilerSymbolId: string }
>;

export type McpToolPolicy = {
  resourceFamily: string;
  exposureTier: {
    current: 'eager-core' | 'profile-gated' | 'lazy-discoverable';
    target?: 'eager-core' | 'profile-gated' | 'lazy-discoverable';
    evidenceRef: EvidenceRef;
  };
  runtimeProfiles: NonEmptyReadonlyArray<McpRuntimeProfile>;
  owner: { domainCell: `architecture-cell:${string}`; surface: 'mcp-surface-governance' };
  standaloneReason: McpStandaloneReason;
  activeState: 'canonical' | 'migration-candidate';
  cognitiveEntryPoints: NonEmptyReadonlyArray<{
    kind: 'tool-description' | 'skill' | 'l0' | 'progressive-disclosure';
    ref: EvidenceRef;
  }>;
  verification: NonEmptyReadonlyArray<{ kind: 'test' | 'guard' | 'contract'; ref: EvidenceRef }>;
};

export type McpToolDefinitionInput = {
  name: string;
  description: string;
  operation: McpOperationContract;
  implementation: McpImplementationBinding;
  policy: McpToolPolicy;
};

/** Phase B-only input for identities proven to exist on the protected base. */
export type McpMigrationCandidateInput = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: McpImplementationBinding['run'];
  governance: {
    sourceRef: `file:${string}`;
    verificationRef: `test:${string}`;
    implementationRef: McpImplementationBinding['ref'];
    resourceFamily: string;
    action: string;
    boundary: McpActionBoundary;
    customDiscriminators?: readonly string[];
    runtimeProfiles: NonEmptyReadonlyArray<McpRuntimeProfile>;
    targetExposure?: 'profile-gated' | 'lazy-discoverable';
  };
};

export type McpToolDefinition = Readonly<
  McpToolDefinitionInput & {
    inputSchema: Record<string, unknown>;
    handler: McpImplementationBinding['run'];
    actionInventory: readonly string[];
    effectiveRisk: McpRisk;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  }
>;

export type ProtectedToolSnapshot = {
  name: string;
  resourceFamily: string;
  actions: readonly string[];
  risk: McpRisk;
  inputSchemaDigest: string;
};

export type GovernanceFinding = {
  code:
    | 'duplicate-tool-name'
    | 'mixed-action-boundary'
    | 'unjustified-family-growth'
    | 'new-family-requires-resource-entry'
    | 'unresolved-evidence-ref'
    | 'admission-subject-mismatch'
    | 'unresolved-implementation-binding'
    | 'protected-base-drift'
    | 'hidden-operation-discriminator'
    | 'invalid-policy';
  toolName?: string;
  message: string;
};

export type ToolRegistryDelta = {
  addedNames: readonly string[];
  removedNames: readonly string[];
  resourceActionChanges: readonly {
    resourceFamily: string;
    added: readonly string[];
    removed: readonly string[];
  }[];
  profileChanges: readonly { name: string; added: readonly string[]; removed: readonly string[] }[];
};
