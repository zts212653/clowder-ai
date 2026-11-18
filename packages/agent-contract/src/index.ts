import type {
  AgyProfileConfig,
  CatCarrier,
  CatColor,
  CatVariant,
  CliConfig,
  ClientId,
  VoiceConfig,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const AGENT_ACCESS_PLUGIN_ID = 'official.agent-access';
export const AGENT_ACCESS_DECLARATION_FILE = 'agent-access.json';
export const AGENT_ACCESS_PROTOCOL_VERSION = 1;

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

export const agentAccessDetectRequestSchema = z.object({ refresh: z.boolean().optional() }).strict();

export const agentAccessDetectionSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      clientId: z.string(),
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
  readCatalog(): Promise<{ readonly source: string; readonly revision: string }>;
  commitCatalog(revision: string, source: string): Promise<'committed' | 'conflict'>;
  readTemplateTombstone(
    catId: string,
  ): Promise<{ readonly breedId: string; readonly variantId: string; readonly catId: string } | null>;
}

export type AgentAccessRoleMutation =
  | { kind: 'create'; input: RuntimeCatInput }
  | { kind: 'update'; catId: string; expectedRevision: string; patch: RuntimeCatUpdate }
  | { kind: 'delete'; catId: string; expectedRevision: string };

export type AgentAccessRoleMutationResult = { status: 'committed'; catId: string } | { status: 'conflict' };
