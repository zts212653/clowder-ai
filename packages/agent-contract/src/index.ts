import type {
  AgyProfileConfig,
  CatCarrier,
  CatColor,
  CatId,
  CatVariant,
  CliConfig,
  ClientId,
  VoiceConfig,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const AGENT_ACCESS_PLUGIN_ID = 'official.agent-access';
export const AGENT_ACCESS_DECLARATION_FILE = 'agent-access.json';
export const AGENT_ACCESS_PROTOCOL_VERSION = 1;
export const AGENT_ACCESS_ACP_PROCESS_ACTION = 'acpProcessV2';
export const AGENT_ACCESS_ACP_SESSION_ACTION = 'acpSessionV2';

export const AGENT_ACCESS_OPERATIONS = [
  'detect',
  'configure',
  'login',
  'readRoles',
  'writeRole',
  'openSession',
  'startTurn',
  'cancel',
  'release',
] as const;

/** Operations called by the Host's first-party Agent Access integration. */
export const OFFICIAL_AGENT_ACCESS_OPERATIONS = [
  ...AGENT_ACCESS_OPERATIONS,
  'acpDshTurn',
  AGENT_ACCESS_ACP_PROCESS_ACTION,
  AGENT_ACCESS_ACP_SESSION_ACTION,
  'parseNativeEvent',
  'projectAgyOutput',
  'summarizeAgyTurn',
  'planCodexExec',
  'planCodexAppServerThread',
  'planCodexAppServerTurn',
  'planCodexLogin',
  'projectCatAgentOutput',
  'projectClaudeBatch',
  'projectClaudeOutput',
  'selectAcpModel',
  'testDshConnection',
  'planFinalizer',
] as const;

// Managed OAuth may use this login command in a Host-owned attempt directory.
// Other Codex commands and configuration are outside the credential grant.
export const codexManagedLoginArgs = ['-c', 'cli_auth_credentials_store="file"', 'login'] as const;
export const agentAccessCodexLoginArgsSchema = z.tuple([
  z.literal(codexManagedLoginArgs[0]),
  z.literal(codexManagedLoginArgs[1]),
  z.literal(codexManagedLoginArgs[2]),
]);

const declarationSchema = z.object({
  protocolVersion: z.literal(AGENT_ACCESS_PROTOCOL_VERSION),
  operations: z
    .array(z.string())
    .refine((values) => AGENT_ACCESS_OPERATIONS.every((operation) => values.includes(operation))),
  transports: z
    .array(z.string())
    .refine((values) =>
      values.some((transport) => transport === 'native' || transport === 'acp' || transport === 'a2a'),
    ),
});

export type AgentAccessDeclaration = z.infer<typeof declarationSchema>;

/** Parse the v1 envelope once at admission. Later minor revisions may add optional data. */
export function parseAgentAccessDeclaration(input: unknown) {
  return declarationSchema.safeParse(input);
}

export const agentAccessReadinessSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready') }),
  z.object({
    state: z.enum(['missing', 'disabled', 'starting', 'failed', 'incompatible']),
    action: z.enum(['install', 'enable', 'retry', 'repair']).optional(),
  }),
]);

export type AgentAccessReadiness = z.infer<typeof agentAccessReadinessSchema>;

const clientIdSchema = z.enum(['anthropic', 'openai', 'google', 'kimi', 'antigravity', 'opencode', 'catagent', 'acp']);

export const agentAccessKimiLaunchRequestSchema = z.object({
  operation: z.literal('plan_native_launch'),
  client: z.literal('kimi'),
  launch: z.object({
    prompt: z.string(),
    agentFile: z.string().optional(),
    resumeSessionId: z.string().optional(),
    skillsDirectory: z.string().optional(),
    model: z.string().optional(),
    imageAccessDirs: z.array(z.string()).readonly(),
    cliConfigArgs: z.array(z.string()).readonly().optional(),
  }),
});
export type AgentAccessKimiLaunch = z.infer<typeof agentAccessKimiLaunchRequestSchema>['launch'];

/**
 * OpenCode launches need two values only the Host can establish: the approval flag
 * its `run --help` probe found, and the transport args it resolved. They travel as
 * inputs so the package plans argv without ever spawning anything.
 */
export const agentAccessOpenCodeLaunchRequestSchema = z.object({
  operation: z.literal('plan_native_launch'),
  client: z.literal('opencode'),
  launch: z.object({
    prompt: z.string(),
    sessionId: z.string().optional(),
    model: z.string().optional(),
    readOnly: z.boolean().optional(),
    cliConfigArgs: z.array(z.string()).readonly().optional(),
    approvalFlag: z.string().optional(),
    transportArgs: z.array(z.string()).readonly().optional(),
    /** Host-owned agent name for the read-only run; required so the package never guesses it. */
    readOnlyAgent: z.string().min(1),
  }),
});
export type AgentAccessOpenCodeLaunch = z.infer<typeof agentAccessOpenCodeLaunchRequestSchema>['launch'];

/**
 * Codex exec launches are assembled from Host-resolved groups: credentials, L0,
 * MCP, images and the model catalog stay Host-owned, while the package owns the
 * exec/resume envelope, flag order, user-override precedence and the stdin prompt
 * marker. App-server launches are deliberately not part of this contract.
 */
export const agentAccessCodexExecLaunchRequestSchema = z.object({
  operation: z.literal('plan_native_launch'),
  client: z.literal('codex'),
  launch: z.object({
    sessionId: z.string().optional(),
    readOnly: z.boolean(),
    /**
     * Opaque Host-held groups. The package only orders these tokens; it never
     * receives their contents, so it cannot remove or re-key L0, MCP, sandbox
     * or approval values.
     */
    groups: z.object({
      readOnly: z.string().optional(),
      beforeSandbox: z.string().optional(),
      sandbox: z.string().optional(),
      afterSandbox: z.string().optional(),
      serviceTier: z.string().optional(),
      user: z.string().optional(),
      tail: z.string().optional(),
    }),
  }),
});
export type AgentAccessCodexExecLaunch = z.infer<typeof agentAccessCodexExecLaunchRequestSchema>['launch'];

const codexAppServerSandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
const codexAppServerApprovalSchema = z.enum(['untrusted', 'on-failure', 'on-request', 'never']);
const codexAppServerReviewerSchema = z.enum(['user', 'auto_review', 'guardian_subagent']);

const codexAppServerThreadGroupsSchema = z.object({
  threadId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  developerInstructions: z.string().optional(),
  config: z.string().optional(),
});

/**
 * App-server thread params. The package owns the JSON-RPC parameter shape, but
 * every sensitive value is an opaque Host group token; the Host validates the
 * token at its expected slot and fills it in only after planning.
 */
export const agentAccessCodexAppServerThreadRequestSchema = z.object({
  operation: z.literal('plan_app_server_thread'),
  client: z.literal('codex'),
  kind: z.enum(['start', 'resume']),
  groups: codexAppServerThreadGroupsSchema,
  options: z.object({
    sandbox: codexAppServerSandboxSchema.optional(),
    approvalPolicy: codexAppServerApprovalSchema.optional(),
    serviceTier: z.string().nullable().optional(),
    approvalsReviewer: codexAppServerReviewerSchema.optional(),
  }),
});
export type AgentAccessCodexAppServerThreadRequest = z.infer<typeof agentAccessCodexAppServerThreadRequestSchema>;
export const agentAccessCodexAppServerThreadPlanSchema = z.object({
  params: z.record(z.unknown()),
  startParams: z.record(z.unknown()).optional(),
});

/** App-server turn/start params. Same opaque-group boundary as the thread plan. */
export const agentAccessCodexAppServerTurnRequestSchema = z.object({
  operation: z.literal('plan_app_server_turn'),
  client: z.literal('codex'),
  groups: z.object({
    threadId: z.string(),
    clientUserMessageId: z.string().optional(),
    prompt: z.string().optional(),
    images: z.array(z.string()).readonly().optional(),
    recoveryContext: z.string().optional(),
    outputSchema: z.string().optional(),
    collaborationMode: z.string().optional(),
  }),
});
export type AgentAccessCodexAppServerTurnRequest = z.infer<typeof agentAccessCodexAppServerTurnRequestSchema>;
export const agentAccessCodexAppServerTurnPlanSchema = z.object({
  params: z.record(z.unknown()),
});

/**
 * Static provider notification projection. This is a method table, not a field
 * path DSL: the Host keeps its existing envelope mapping, thread/turn checks,
 * terminal handling and approval/cancel authority.
 */
export const agentAccessCodexAppServerNotificationProjectionSchema = z.object({
  version: z.literal(1),
  methods: z.array(z.string().min(1).max(200)).readonly(),
  ignoredMethods: z.array(z.string().min(1).max(200)).readonly().default([]),
  /** Version 1 aliases project agent text deltas from native envelopes with matching thread and turn IDs. */
  aliases: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).readonly().default({}),
});
export type AgentAccessCodexAppServerNotificationProjection = z.infer<
  typeof agentAccessCodexAppServerNotificationProjectionSchema
>;

/** One envelope per native client; the Host routes by the discriminant. */
export const agentAccessNativeLaunchRequestSchema = z.discriminatedUnion('client', [
  agentAccessKimiLaunchRequestSchema,
  agentAccessOpenCodeLaunchRequestSchema,
]);
export type AgentAccessNativeLaunchRequest = z.infer<typeof agentAccessNativeLaunchRequestSchema>;

/**
 * The OpenCode recovery run: after the CLI stops on a tool call the Host asks for a
 * final answer with a tool-free agent. It is a separate operation because its inputs
 * are the Host's own continuation, not a member-editor launch.
 */
export const agentAccessOpenCodeFinalizerRequestSchema = z.object({
  operation: z.literal('plan_native_finalizer'),
  client: z.literal('opencode'),
  launch: z.object({
    prompt: z.string(),
    model: z.string(),
    finalizerAgent: z.string().min(1),
    sessionId: z.string().optional(),
    transportArgs: z.array(z.string()).readonly().optional(),
  }),
});
export type AgentAccessOpenCodeFinalizer = z.infer<typeof agentAccessOpenCodeFinalizerRequestSchema>['launch'];

export const agentAccessNativeLaunchArgumentsSchema = z.object({
  args: z.array(z.string()),
  managedArgvFlags: z.array(z.string()),
});
export type AgentAccessNativeLaunchArguments = z.infer<typeof agentAccessNativeLaunchArgumentsSchema>;

/** Shared by every native client: the token fields the Host's usage contract reads. */
export const agentAccessTokenUsageSchema = z.object({
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  lastTurnInputTokens: z.number().optional(),
  contextWindowSize: z.number().optional(),
  contextUsedTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

export const agentAccessKimiEventRequestSchema = z.object({
  client: z.literal('kimi'),
  event: z.unknown(),
});
export const agentAccessKimiEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignored') }),
  z.object({ kind: z.literal('resume'), sessionId: z.string().min(1) }),
  z.object({
    kind: z.literal('assistant'),
    sessionId: z.string().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    usage: agentAccessTokenUsageSchema.optional(),
    tools: z.array(z.object({ name: z.string(), input: z.record(z.unknown()) })),
  }),
]);
export type AgentAccessKimiEvent = z.infer<typeof agentAccessKimiEventSchema>;

/**
 * OpenCode's wire event keeps the step timestamp the CLI reported, because the Host
 * maps it 1:1 onto its own message and must not substitute a read-time clock.
 */
export const agentAccessOpenCodeEventRequestSchema = z.object({
  client: z.literal('opencode'),
  event: z.unknown(),
});
export const agentAccessOpenCodeEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignored') }),
  z.object({ kind: z.literal('session_init'), sessionId: z.string().min(1), timestamp: z.number() }),
  z.object({ kind: z.literal('text'), text: z.string(), timestamp: z.number() }),
  z.object({ kind: z.literal('thinking'), text: z.string(), timestamp: z.number() }),
  z.object({
    kind: z.literal('tool'),
    name: z.string(),
    input: z.record(z.unknown()).optional(),
    timestamp: z.number(),
  }),
  z.object({ kind: z.literal('usage'), usage: agentAccessTokenUsageSchema, timestamp: z.number() }),
  z.object({
    kind: z.literal('error'),
    message: z.string(),
    statusCode: z.number().optional(),
    timestamp: z.number(),
  }),
]);
export type AgentAccessOpenCodeEvent = z.infer<typeof agentAccessOpenCodeEventSchema>;

export const agentAccessNativeEventRequestSchema = z.discriminatedUnion('client', [
  agentAccessKimiEventRequestSchema,
  agentAccessOpenCodeEventRequestSchema,
]);
export type AgentAccessNativeEventRequest = z.infer<typeof agentAccessNativeEventRequestSchema>;

export const agentAccessClientDirectorySchema = z.object({
  clients: z.array(z.object({ id: clientIdSchema, label: z.string() })),
});
export type AgentAccessClientDirectory = z.infer<typeof agentAccessClientDirectorySchema>;

export const agentAccessRoleProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  nickname: z.string().optional(),
  banner: z.string().optional(),
  color: z.object({ primary: z.string(), secondary: z.string() }),
  mentionPatterns: z.array(z.string()),
  roleDescription: z.string(),
  personality: z.string().optional(),
  teamStrengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  restrictions: z.array(z.string()).optional(),
  strengths: z.array(z.string()).optional(),
});
export type AgentAccessRoleProfile = z.infer<typeof agentAccessRoleProfileSchema>;

export const agentAccessRoleCardsSchema = z.array(
  agentAccessRoleProfileSchema.extend({
    configurationRevision: z.string().optional(),
    effectiveProfile: z.literal(true).optional(),
    restrictions: z.array(z.string()),
    client: z.object({
      id: z.string(),
      label: z.string(),
      type: z.enum(['legacy', 'plugin', 'cloud']),
    }),
  }),
);
export type AgentAccessRoleCard = z.infer<typeof agentAccessRoleCardsSchema>[number];

export const agentAccessDetectRequestSchema = z.object({ refresh: z.boolean().optional() }).strict();

export const agentAccessDetectionSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      clientId: clientIdSchema,
      installed: z.boolean(),
      models: z.array(z.string()),
      command: z.string().optional(),
      startupArgs: z.array(z.string()).optional(),
      agyCarrier: z.enum(['native', 'acp']).optional(),
      readiness: z
        .object({
          status: z.enum(['login_required', 'configured', 'unknown', 'not_installed']),
          checkedAt: z.number(),
          loginCommand: z.string().optional(),
          loginShell: z.enum(['powershell', 'sh']).optional(),
        })
        .optional(),
      discoveryStatus: z
        .enum(['configured', 'acp_profile_missing', 'acp_profile_invalid', 'adapter_missing', 'not_installed'])
        .optional(),
      dshSetupSupported: z.boolean().optional(),
      dshDesktop: z.boolean().optional(),
      onboardingEligible: z.boolean().optional(),
      env: z.object({ DSH_HOME: z.string().optional() }).optional(),
      configuredModel: z.string().optional(),
      modelSource: z.enum(['tool_config', 'tool_recent']).optional(),
      defaultsStatus: z.enum(['configured_only', 'unconfigured', 'session_only']).optional(),
      configuredEffort: z.string().optional(),
      configuredThinkingEnabled: z.boolean().optional(),
      modelCatalog: z
        .array(
          z.object({
            value: z.string(),
            label: z.string(),
            defaultEffort: z.string().optional(),
            efforts: z.array(z.object({ value: z.string(), label: z.string() })),
          }),
        )
        .optional(),
      acp: z
        .object({
          agentProvider: z.string().optional(),
          command: z.string(),
          startupArgs: z.array(z.string()),
          transport: z.enum(['stdio', 'httpstream']).optional(),
        })
        .optional(),
    }),
  ),
  partialFailures: z.array(z.object({ id: z.string() })).optional(),
});

export type AgentAccessDetection = z.infer<typeof agentAccessDetectionSchema>;

export interface AgentAccessDetectionContext {
  readonly projectRoot: string;
  readonly piBridgeEntry: string;
  readonly members: readonly {
    readonly id: string;
    readonly clientId: string;
    readonly displayName: string;
    readonly defaultModel?: string;
    readonly agentProvider?: string | null;
    readonly agyProfile?: { readonly carrier?: string; readonly enabled?: boolean; readonly model?: string };
    readonly env?: { readonly DSH_HOME?: string };
    readonly acp?: {
      readonly command: string;
      readonly startupArgs: string[];
      readonly transport?: 'stdio' | 'httpstream';
      readonly agentProvider?: string | null;
    };
  }[];
}

export interface AgentAccessDiscoveryHost {
  readDetectionContext(): Promise<AgentAccessDetectionContext>;
  inspectNativeLogin(client: 'codex' | 'claude', executable: string): Promise<unknown>;
}

export interface AcpVariantConfig {
  /** Stable plugin reference; the Host resolves launch settings from the active plugin. */
  agentProvider?: string;
  command: string;
  startupArgs: string[];
  /** Optional owner-selected absolute root; full directory checks, no automatic relocation. */
  bootstrapRoot?: string;
  /** F161 Phase C: ACP wire transport. 'stdio' = NDJSON over stdin/stdout (default). 'httpstream' = spawn process that listens on HTTP port. */
  transport?: 'stdio' | 'httpstream';
  /** Required for httpstream until ACP publishes a stable HTTP transport spec. */
  experimental?: boolean;
  mcpWhitelist?: string[];
  /** Explicit plugin permission policy; native clients retain their existing policy. */
  permissionPolicy?: 'deny' | 'auto_allow';
  supportsMultiplexing?: boolean;
  /** iCode protocol adapter: switches AcpAgentService onto iCode's ACP dialect (session/set_model, per-turn session/close, no stdio MCP injection). */
  protocolAdapter?: 'icode';
  /** iCode: model configuration id sent to session/set_model (distinct from defaultModel). */
  modelProfileId?: string;
  /** Phase C: optional pool config overrides */
  pool?: {
    maxLiveProcesses?: number;
    idleTtlMs?: number;
  };
}

export interface RuntimeCatInput {
  catId: string;
  creationReceipt?: CatVariant['creationReceipt'];
  breedId?: string;
  name: string;
  displayName: string;
  variantLabel?: string;
  nickname?: string;
  avatar: string;
  banner?: string;
  color: CatColor;
  mentionPatterns: string[];
  accountRef?: string;
  configurationSource?: 'native_tool' | 'managed_account';
  agentProvider?: string | null;
  roleDescription: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  restrictions?: string[];
  strengths?: string[];
  sessionChain?: boolean;
  clientId: ClientId;
  carrier: CatCarrier;
  defaultModel: string;
  executionApproval?: 'auto' | 'ask_user';
  mcpSupport: boolean;
  env?: Record<string, string>;
  /** F247 KD-17: cloud-only cats (Remote MCP) omit cli to skip local dispatch.
   * When cli is absent, mention routing queues the mention without spawning a CLI. */
  cli?: CliConfig;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  /** clowder-ai#1208: explicit context window cap (tokens). undefined = Auto. */
  contextWindow?: number;
  voiceConfig?: VoiceConfig;
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider?: string;
  /** F161: ACP transport config — presence triggers ACP transport instead of CLI. */
  acp?: AcpVariantConfig;
  agyProfile?: AgyProfileConfig;
}

export interface RuntimeCatUpdate {
  /** Move this member into an existing breed without changing its catId. */
  breedId?: string;
  name?: string;
  displayName?: string;
  variantLabel?: string | null;
  nickname?: string;
  avatar?: string;
  banner?: string | null;
  color?: CatColor;
  mentionPatterns?: string[];
  accountRef?: string | null;
  configurationSource?: 'native_tool' | 'managed_account' | null;
  agentProvider?: string | null;
  accountBindingMode?: 'follow' | 'override';
  roleDescription?: string;
  personality?: string;
  teamStrengths?: string;
  caution?: string | null;
  restrictions?: string[] | null;
  strengths?: string[];
  sessionChain?: boolean;
  clientId?: ClientId;
  carrier?: CatCarrier;
  defaultModel?: string;
  executionApproval?: 'auto' | 'ask_user';
  mcpSupport?: boolean;
  env?: Record<string, string> | null;
  /** F247 KD-17: cli null to remove (cloud-only mode), CliConfig to update, undefined to skip. */
  cli?: CliConfig | null;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  /** clowder-ai#1208: explicit context window cap. null to remove, undefined to skip. */
  contextWindow?: number | null;
  voiceConfig?: VoiceConfig | null;
  /** clowder-ai#340 P5: Model provider name (renamed from ocProviderName). */
  provider?: string | null;
  available?: boolean;
  /** F161: ACP transport config — null to remove, undefined to skip. */
  acp?: AcpVariantConfig | null;
  agyProfile?: AgyProfileConfig | null;
}

export interface AgentAccessRoleStore {
  readCatalog(): Promise<{
    readonly source: string;
    readonly revision: string;
    /** Public fields resolved by the Host's shared catalog loader for card reads. */
    readonly profiles?: Readonly<Record<string, AgentAccessRoleProfile>>;
  }>;
  commitCatalog(
    revision: string,
    source: string,
    change: { kind: AgentAccessRoleMutation['kind']; catId?: string; requireAccountCheck?: boolean },
  ): Promise<'committed' | 'conflict'>;
  readRegisteredAliases(): Promise<readonly { id: string; mentionPatterns: readonly string[] }[]>;
  readTemplateTombstone(
    catId: string,
  ): Promise<{ readonly breedId: string; readonly variantId: string; readonly catId: string } | null>;
}

export type AgentAccessRoleMutation =
  | { kind: 'create'; input: RuntimeCatInput; receipt?: RuntimeCatInput['creationReceipt'] }
  | { kind: 'update'; catId: string; expectedRevision: string; patch: RuntimeCatUpdate }
  | { kind: 'delete'; catId: string; expectedRevision: string }
  | {
      kind: 'bind';
      client: 'openai' | 'anthropic' | 'google';
      scope: 'cat' | 'family' | 'local';
      accountRef: string;
      targetIds: readonly string[];
    };

export const agentAccessRoleMutationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('committed'), catId: z.string(), replayed: z.literal(true).optional() }),
  z.object({ status: z.literal('conflict') }),
  z.object({ status: z.literal('invalid_dsh_profile') }),
  z.object({ status: z.literal('bound'), catIds: z.array(z.string()) }),
  z.object({ status: z.literal('creation_conflict'), message: z.string() }),
]);

export type AgentAccessRoleMutationResult = z.infer<typeof agentAccessRoleMutationResultSchema>;

export interface AgentAccessA2ATurn {
  readonly catId: CatId;
  readonly taskId: string;
  readonly prompt: string;
}

/** F050 wire request for the exact turn previously admitted by the Host. */
export function buildAgentAccessA2ARequest({ taskId, prompt }: Pick<AgentAccessA2ATurn, 'taskId' | 'prompt'>) {
  return {
    jsonrpc: '2.0',
    id: taskId,
    method: 'tasks/send',
    params: {
      id: taskId,
      message: { role: 'user', parts: [{ type: 'text', text: prompt }] },
    },
  };
}

export interface AgentAccessA2AResponse {
  readonly status: number;
  readonly statusText: string;
  readonly payload?: unknown;
}

export type AgentAccessA2ASubmit = (body: string) => Promise<AgentAccessA2AResponse>;

export type AgentAccessA2AEvent = {
  readonly type: 'text' | 'done' | 'error' | 'system_info';
  readonly catId: CatId;
  readonly content?: string;
  readonly error?: string;
  readonly timestamp: number;
};

export const agentAccessA2AEventsSchema = z.array(
  z.object({
    type: z.enum(['text', 'done', 'error', 'system_info']),
    catId: z.string(),
    content: z.string().optional(),
    error: z.string().optional(),
    timestamp: z.number(),
  }),
);

export type AgentAccessA2ARunner = (
  input: AgentAccessA2ATurn,
  submit: AgentAccessA2ASubmit,
) => Promise<readonly AgentAccessA2AEvent[]>;

export const agentAccessLoginRequestSchema = z
  .object({ id: z.string().min(1).max(256), refresh: z.boolean().optional() })
  .strict();
export const agentAccessClientSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['plugin', 'legacy', 'cloud']),
  pluginName: z.string().optional(),
  why: z.string().optional(),
});
