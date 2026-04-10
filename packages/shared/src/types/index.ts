/**
 * Types Index
 * 导出所有类型定义
 */

// A2A Protocol types (F050 Phase 3)
export type {
  A2AAgentCard,
  A2AAgentConfig,
  A2AArtifact,
  A2AJsonRpcResponse,
  A2AMessage,
  A2APart,
  A2ATask,
  A2ATaskStatus,
} from './a2a.js';
// Authorization types (猫猫授权系统)
export type {
  AuthorizationAuditEntry,
  AuthorizationRequestEvent,
  AuthorizationRespondEvent,
  AuthorizationRule,
  PendingRequestRecord,
  PermissionRequest,
  PermissionResponse,
  PermissionStatusResponse,
  RespondScope,
} from './authorization.js';
// Backlog types (F049 Mission Control)
export type {
  AcquireBacklogLeaseInput,
  AtomicDispatchInput,
  BacklogAuditAction,
  BacklogAuditActor,
  BacklogAuditEntry,
  BacklogClaimSuggestion,
  BacklogDependencies,
  BacklogItem,
  BacklogLease,
  BacklogLeaseState,
  BacklogPriority,
  BacklogStatus,
  BacklogSuggestionStatus,
  CreateBacklogItemInput,
  DecideBacklogClaimInput,
  DispatchBacklogItemInput,
  FeatureDocAC,
  FeatureDocDetail,
  FeatureDocPhase,
  FeatureDocRisk,
  HeartbeatBacklogLeaseInput,
  MarkDoneInput,
  ReclaimBacklogLeaseInput,
  RefreshBacklogItemInput,
  ReleaseBacklogLeaseInput,
  SuggestBacklogClaimInput,
  ThreadPhase,
  UpdateBacklogDispatchProgressInput,
} from './backlog.js';
// Brake types (F085 Phase 4 — 平台级健康守护)
export type {
  BrakeCheckinRequest,
  BrakeCheckinResponse,
  BrakeEvent,
  BrakeSettings,
  BrakeState,
} from './brake.js';
// Capability types (F041 统一能力模型)
export type {
  BootstrapAction,
  BootstrapReport,
  CapabilitiesConfig,
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CapabilityEntry,
  CapabilityPatchRequest,
  CatCapabilityOverride,
  CatFamily,
  DispatchExecutionDigest,
  DispatchMissionPack,
  DoneWhenResult,
  GovernanceCategory,
  GovernanceFinding,
  GovernanceHealthSummary,
  GovernancePackMeta,
  GovernanceRule,
  McpServerDescriptor,
  McpToolInfo,
  SkillHealthSummary,
} from './capability.js';
// Cat types
export type {
  CatColor,
  CatConfig,
  /** @deprecated F340: Use ClientId instead. */
  CatProvider,
  CatState,
  CatStatus,
  ClientId,
} from './cat.js';
export {
  CAT_CONFIGS,
  findCatByMention,
  getAllCatIds,
} from './cat.js';
// Cat breed/variant types (Breed+Variant two-layer schema)
export type {
  // F136 Phase 4: Account config types
  AccountConfig,
  AccountProtocol,
  CatBreed,
  CatCafeConfig,
  CatCafeConfigV1,
  CatCafeConfigV2,
  CatFeatures,
  CatVariant,
  CliConfig,
  // F067: Co-Creator config for @ mention routing
  CoCreatorConfig,
  ContextBudget,
  CredentialEntry,
  MissionHubSelfClaimScope,
  // F032: Roster types for collaboration rules
  ReviewPolicy,
  Roster,
  RosterEntry,
} from './cat-breed.js';
// Command types (F142 Phase B — slash command framework)
export type {
  CommandSource,
  CommandSurface,
  ParsedCommand,
  SlashCommandDefinition,
} from './command.js';
// Connector types (F97 外部信息源抽象)
export type {
  ConnectorDefinition,
  ConnectorSource,
  ConnectorTailwindTheme,
  ConnectorThreadBinding,
  OutboundDeliveryTarget,
} from './connector.js';
export {
  getAllConnectorDefinitions,
  getConnectorDefinition,
} from './connector.js';
// Deliberate types (4-E 两轮制 - 类型预埋)
export type {
  DeliberateEvent,
  DeliberatePhase,
  DeliberateSession,
  DeliberateTransition,
} from './deliberate.js';
// External project types (F076 跨项目作战面板)
export type {
  CreateExternalProjectInput,
  ExternalProject,
} from './external-project.js';
// Game engine types (F101)
export type {
  ActionDefinition,
  ActionStatus,
  ActorType,
  Ballot,
  EventScope,
  GameAction,
  GameConfig,
  GameDefinition,
  GameEvent,
  GameResultStats,
  GameRuntime,
  GameView,
  PendingAction,
  PhaseDefinition,
  Resolution,
  RoleDefinition,
  Seat,
  SeatId,
  SeatView,
  WinCondition,
} from './game.js';
export {
  isGameEvent,
  isSeatId,
  isValidActionStatus,
  isValidScope,
} from './game.js';
// ID types
export type {
  CatId,
  MessageId,
  SessionId,
  ThreadId,
  UserId,
} from './ids.js';
export {
  createCatId,
  createMessageId,
  createSessionId,
  createThreadId,
  createUserId,
  generateId,
  generateMessageId,
  generateSessionId,
  generateThreadId,
} from './ids.js';
// Intent Card + Need Audit types (F076 需求翻译官)
export type {
  CreateIntentCardInput,
  CreateNeedAuditFrameInput,
  IntentCard,
  NeedAuditFrame,
  ResolutionPath,
  RiskDetectionResult,
  RiskSignal,
  SizeBand,
  SourceTag,
  TriageBucket,
  TriageIntentCardInput,
  TriageResult,
} from './intent-card.js';
// Leaderboard types (F075 排行榜)
export type {
  Achievement,
  CvoLevel,
  GameRecord,
  GameRecordInput,
  GameStats,
  LeaderboardEvent,
  LeaderboardRange,
  LeaderboardStatsResponse,
  MentionStats,
  RankedCat,
  SillyCatEntry,
  SillyStats,
  StreakCat,
  WorkStats,
} from './leaderboard.js';
// Limb types (F126 四肢控制面)
export type {
  ILimbNode,
  LimbAccessEntry,
  LimbActionLogEntry,
  LimbAuthLevel,
  LimbCapability,
  LimbInvokeResult,
  LimbLease,
  LimbNodeRecord,
  LimbNodeStatus,
} from './limb.js';
// Memory types (F3-lite 显式记忆)
export type {
  MemoryEntry,
  MemoryInput,
} from './memory.js';
// Message types
export type {
  AgentStreamMessage,
  CodeContent,
  ImageContent,
  Message,
  MessageContent,
  MessageSender,
  MessageStatus,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from './message.js';
export {
  createCatMessage,
  createUserMessage,
} from './message.js';
// Multi-mention types (F086 Cat Orchestration)
export type {
  MultiMentionRequest,
  MultiMentionResponse,
  MultiMentionResponseStatus,
  MultiMentionResult,
  MultiMentionStatus,
  MultiMentionTriggerType,
} from './multi-mention.js';
export {
  ALL_MULTI_MENTION_STATUSES,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_MULTI_MENTION_TARGETS,
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  MULTI_MENTION_TERMINAL_STATES,
} from './multi-mention.js';
// Pack System types (F129 Multi-Agent Mod)
export type {
  CompiledPackBlocks,
  ConstraintSeverity,
  MaskActivation,
  PackBehavior,
  PackCompatibility,
  PackConstraint,
  PackDefaults,
  PackGuardrails,
  PackManifest,
  PackMask,
  PackOnDisk,
  PackScope,
  PackType,
  PackWorkflow,
  PackWorkflowStep,
  PackWorldDriver,
  ResolverType,
  WorkflowAction,
} from './pack.js';
// Reflux types (F076 Phase 2 — 回流)
export type {
  CreateRefluxPatternInput,
  RefluxCategory,
  RefluxPattern,
} from './reflux.js';
// Resolution types (F076 Phase 2 — 风险消解)
export type {
  AnswerResolutionInput,
  CreateResolutionInput,
  ResolutionItem,
  ResolutionStatus,
} from './resolution.js';
// Rich block types (F22 Rich Blocks 富消息系统)
export type {
  InteractiveOption,
  RichAudioBlock,
  RichBlock,
  RichBlockBase,
  RichBlockKind,
  RichCardBlock,
  RichChecklistBlock,
  RichDiffBlock,
  RichFileBlock,
  RichHtmlWidgetBlock,
  RichInteractiveBlock,
  RichMediaGalleryBlock,
  RichMessageExtra,
} from './rich.js';
export { normalizeRichBlock } from './rich.js';
// Session chain types (F24 Session Chain + Context Health)
export type {
  ContextHealth,
  ContextHealthConfig,
  SealReason,
  SealResult,
  SessionRecord,
  SessionStatus,
  SessionStrategy,
  SessionStrategyConfig,
  SessionUsageSnapshot,
  StrategyAction,
} from './session.js';
// Signals types (F21 Signal Hunter)
export type {
  SignalArticle,
  SignalArticleStatus,
  SignalCategory,
  SignalFetchMethod,
  SignalKeywordFilter,
  SignalScheduleFrequency,
  SignalSource,
  SignalSourceConfig,
  SignalSourceFetchConfig,
  SignalSourceSchedule,
  SignalTier,
} from './signals.js';
// Slice types (F076 Phase 2 — 切片)
export type {
  CreateSliceInput,
  Slice,
  SliceStatus,
  SliceType,
  UpdateSliceInput,
} from './slice.js';
// STT types (F088 Phase 6 — Speech-to-Text)
export type { ISttProvider, SttTranscribeRequest, SttTranscribeResult } from './stt.js';
// Study types (F091 Signal Study Mode)
export type {
  ArtifactJobState,
  ArtifactKind,
  StudyArtifact,
  StudyMeta,
  StudyThreadLink,
} from './study.js';
// Summary types (拍立得照片墙)
export type {
  CreateSummaryInput,
  ThreadSummary,
} from './summary.js';
// Task types (毛线球)
export type {
  AutomationState,
  CiAutomationState,
  ConflictAutomationState,
  CreateTaskInput,
  ReviewAutomationState,
  TaskItem,
  TaskKind,
  TaskStatus,
  UpdateTaskInput,
} from './task.js';
// TTS types (F34 TTS Provider)
export type {
  ITtsProvider,
  TtsStreamEvent,
  TtsStreamRequest,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  VoiceChunkEvent,
  VoiceConfig,
  VoiceStreamEndEvent,
  VoiceStreamEvent,
  VoiceStreamStartEvent,
} from './tts.js';
// Workflow SOP types (F073 告示牌)
export type {
  CheckStatus,
  ResumeCapsule,
  SopChecks,
  SopStage,
  UpdateWorkflowSopInput,
  WorkflowSop,
} from './workflow-sop.js';
