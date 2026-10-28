import { reportAcpHostPolicy, resolveAcpHostPolicy } from './config/acp-host-policy.js';
import { AgentServiceUnavailableError } from './domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { hasRecentWorkPublication } from './domains/cats/services/agents/routing/recent-global-work-reader.js';
import { createRefreshingAcpSessionProvider } from './domains/cats/services/agents/session-contract/acp-session-provider.js';
import {
  SessionImplementationRegistry,
  sessionImplementationKey,
} from './domains/cats/services/agents/session-contract/implementation-registry.js';
import { resolveMemberSessionRef } from './domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import {
  RegisteredSessionAgentService,
  selectSessionAgentService,
} from './domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { readSessionContractSettings } from './domains/cats/services/agents/session-contract/session-contract-settings.js';
import { ContextSourceOpportunityStore } from './domains/memory/cue/ContextSourceOpportunityStore.js';
import {
  createHostMediaPathResolver,
  hostMediaPathRootsFromEnv,
} from './domains/messaging/outbound-media/host-media-paths.js';
import { OutboundMediaPublication } from './domains/messaging/outbound-media/publication.js';
import { createListenAssetSpeech } from './domains/messaging/outbound-media/speech.js';
import { createPublishingMessageStore } from './domains/messaging/publishing-message-store.js';
import { createMessagingStores } from './domains/messaging/stores/factory.js';
import { SubscriptionDrainScheduler } from './domains/messaging/subscription-drain-scheduler.js';
import { declaredAgentSessionProviders } from './domains/plugin/declared/declared-agent-session-providers.js';
import { PLUGIN_HOST_ENTRIES, pluginHostRoot } from './domains/plugin/host-inventory/plugin-host-layout.js';
import { createCollectiveWorkCalendarReader } from './domains/plugin/host-surface/collective-work-calendar.js';
import { createPluginConversationDelivery } from './domains/plugin/host-surface/plugin-conversation-delivery.js';
import { catRegistryMentionPatterns } from './infrastructure/connectors/mention-parser.js';
/**
 * Clowder AI API Server
 * 后端 API 入口
 */

// 必须最先 import：Node 24.16 undici setTypeOfService EINVAL 崩溃防护（见文件头注释）
import './settos-guard.js';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type CatConfig,
  type CatId,
  CORE_COMMANDS,
  catRegistry,
  createCatId,
  deploymentDefaults,
  type EventMemoryRecord,
  type ILimbNode,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createRedisClient, SessionStore } from '@cat-cafe/shared/utils';
import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply } from 'fastify';
import { resolveAnthropicRuntimeProfile, validateRuntimeProviderBinding } from './config/account-resolver.js';
import { resolveInvokeCapabilityRoot } from './config/capabilities/invoke-capability-root.js';
import { migrateStartupCodexMcpConfig, regenerateStartupCliConfigs } from './config/capabilities/startup-cli-config.js';
import { resolveBoundAccountRefForCat, usesNativeToolConfiguration } from './config/cat-account-binding.js';
import {
  bootstrapDefaultCatCatalog,
  getAcpConfig,
  getCoCreatorConfig,
  getConfigSessionStrategy,
  getDefaultCatId,
  isCatAvailable,
  toAllCatConfigs,
} from './config/cat-config-loader.js';
import { getCatModel } from './config/cat-models.js';
import { reconcileCatRegistry } from './config/cat-registry-reconciliation.js';
import { resolveCatRuntimeAccount } from './config/cat-runtime-account.js';
import { configEventBus } from './config/config-event-bus.js';
import {
  createThreadDeepLinkUrl,
  resolveFrontendBaseUrl,
  resolveFrontendCorsOrigins,
} from './config/frontend-origin.js';
import { readMountRules } from './config/mount/mount-rules-store.js';
import {
  resolveRuntimeDeploymentCandidate,
  resolveRuntimeDeploymentInclusionProof,
} from './config/runtime-deployment-inclusion.js';
import { initRuntimeOverrides } from './config/session-strategy-overrides.js';
import { assertStorageReady } from './config/storage-guard.js';
import { ApprovalDecisionReceiptOutbox } from './domains/approval-hub/ApprovalDecisionReceiptOutbox.js';
import { ApprovalDecisionReceiptService } from './domains/approval-hub/ApprovalDecisionReceiptService.js';
import { ApprovalIngress } from './domains/approval-hub/ApprovalIngress.js';
import { RedisApprovalLifecycleEpochAuthority } from './domains/approval-hub/ApprovalLifecycleEpochAuthority.js';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
  bindV1ApprovalProducer,
} from './domains/approval-hub/ApprovalProducerRegistry.js';
import { F128ApprovalAdapter } from './domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { F139ApprovalAdapter } from './domains/approval-hub/adapters/F139ApprovalAdapter.js';
import { F193ApprovalAdapter } from './domains/approval-hub/adapters/F193ApprovalAdapter.js';
import { F221ApprovalAdapter } from './domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { F225ApprovalAdapter } from './domains/approval-hub/adapters/F225ApprovalAdapter.js';
import { F231ApprovalAdapter } from './domains/approval-hub/adapters/F231ApprovalAdapter.js';
import { F260ApprovalAdapter } from './domains/approval-hub/adapters/F260ApprovalAdapter.js';
import { F266ApprovalAdapter } from './domains/approval-hub/adapters/F266ApprovalAdapter.js';
import { F276ApprovalAdapter } from './domains/approval-hub/adapters/F276ApprovalAdapter.js';
import { F306ApprovalAdapter } from './domains/approval-hub/adapters/F306ApprovalAdapter.js';
import { F321ApprovalAdapter } from './domains/approval-hub/adapters/F321ApprovalAdapter.js';
import { installApprovalDecisionReceiptHooks } from './domains/approval-hub/approval-decision-receipt-hooks.js';
import { createDispatchProposalStore } from './domains/approval-hub/stores/factories/DispatchProposalStoreFactory.js';
import { createEntityProposalStore } from './domains/approval-hub/stores/factories/EntityProposalStoreFactory.js';
import { createActionSuccessorRecoveryCycle } from './domains/ball-custody/ActionSuccessorRecoveryCycle.js';
import { classifyApprovedActionCarrier } from './domains/ball-custody/ActionSuccessorRecoverySweep.js';
import { CustodyEventInspector } from './domains/ball-custody/CustodyEventInspector.js';
import { EventWaitDispositionService } from './domains/ball-custody/EventWaitDispositionService.js';
import { createSqliteHoldQuotaStore, type IHoldQuotaStore } from './domains/ball-custody/hold-quota-store.js';
import { RedisHoldQuotaStore } from './domains/ball-custody/hold-quota-store-redis.js';
import type { ManagedCommandWakeRecoverySweep } from './domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { createManagedCommandWakeAdmission } from './domains/ball-custody/managed-command-wake-admission.js';
import { createManagedCommandWakeCarrierAdapter } from './domains/ball-custody/managed-command-wake-carrier-adapter.js';
import { createManagedWakeAdmittedNotifier } from './domains/ball-custody/managed-wake-admitted-notifier.js';
import { RedisWaitTerminationStore } from './domains/ball-custody/RedisWaitTerminationStore.js';
import { WaitTerminationService } from './domains/ball-custody/WaitTerminationService.js';
import { agentSessionMutex } from './domains/cats/services/agents/invocation/AgentSessionMutex.js';
// F297 Phase B: Sidebar C10 production source — domain-owned composition shared by
// queue / active-execution / Sidebar 三个 consumer（PR #3748 R3 P2-1）。
import {
  createActiveExecutionService,
  responseStatusFromMessages,
} from './domains/cats/services/agents/invocation/active-execution-service.js';
import { CallbackAuthTurnExecutionLifecycle } from './domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import type { CollaborationContinuityCapsuleV1 } from './domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js';
import { createTaskProgressStore } from './domains/cats/services/agents/invocation/createTaskProgressStore.js';
import { createExitedCliExecutionRecovery } from './domains/cats/services/agents/invocation/ExitedCliExecutionRecovery.js';
import { InvocationOwnerReaper } from './domains/cats/services/agents/invocation/InvocationOwnerReaper.js';
import { startSerializedInvocationOwnerReaperInterval } from './domains/cats/services/agents/invocation/InvocationOwnerReaperInterval.js';
import {
  actionSuccessorInvocationIdempotencyKey,
  InvocationQueue,
} from './domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  type CallbackAuthLifecycleSignal,
  callbackAuthCapabilityForBackend,
  InvocationRegistry,
  selectInvocationBackendKind,
} from './domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from './domains/cats/services/agents/invocation/InvocationTracker.js';
import { emitLifecycleMessageUpdated } from './domains/cats/services/agents/invocation/lifecycle-message-update.js';
import type { NativeControlReceiptPort } from './domains/cats/services/agents/invocation/NativeControlReceipt.js';
import type {
  InvocationRecordStoreLike,
  RouterLike,
} from './domains/cats/services/agents/invocation/QueueProcessor.js';
import { QueueProcessor } from './domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from './domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from './domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { reconcileZombies } from './domains/cats/services/agents/invocation/reconcileZombies.js';
import {
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from './domains/cats/services/agents/invocation/response-draft-settlement.js';
import { SessionContinuationCoordinator } from './domains/cats/services/agents/invocation/SessionContinuationCoordinator.js';
import { SessionMutex } from './domains/cats/services/agents/invocation/SessionMutex.js';
import { sharedMcpDeploymentId } from './domains/cats/services/agents/invocation/shared-mcp-launch.js';
import {
  createSidebarPresenceSource,
  type SidebarTerminalExecution,
} from './domains/cats/services/agents/invocation/sidebar-presence-source.js';
import {
  listenBeforeTurnExecutionRecovery,
  TurnExecutionStartupReconciler,
} from './domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import { createThreadExecutionSituationSource } from './domains/cats/services/agents/invocation/thread-execution-situation.js';
import { createZombieTerminalRecovery } from './domains/cats/services/agents/invocation/ZombieTerminalRecovery.js';
import {
  type AcpPoolRegistry,
  createAcpServiceForConfig,
} from './domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { closeStaleAcpPools } from './domains/cats/services/agents/providers/acp/acp-pool-registry.js';
import { createGoogleAgentService } from './domains/cats/services/agents/providers/agy-native/agy-native-carrier-selection.js';
import { getCodexAppServerLifecycle } from './domains/cats/services/agents/providers/CodexAppServerLifecycleRegistry.js';
import { isNativeRealtimeCompanionDeployment } from './domains/cats/services/agents/providers/CodexRealtimeFeatureConfig.js';
import {
  type CodexAppServerPoolRegistry,
  closeStaleCodexAppServerPools,
  getOrCreateCodexAppServerPool,
} from './domains/cats/services/agents/providers/codex-app-server-pool-registry.js';
import { clearL0Cache, clearL0CacheOwner, warmL0Cache } from './domains/cats/services/agents/providers/l0-compiler.js';
import { AgentRegistry } from './domains/cats/services/agents/registry/AgentRegistry.js';
import { createPostCompactContextProjector } from './domains/cats/services/agents/routing/post-compact-context-projector.js';
import { FreshnessAttentionEventLog } from './domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import { FreshnessInvocationStateStore } from './domains/cats/services/freshness/FreshnessInvocationStateStore.js';
import { FreshnessOutputCommitCoordinator } from './domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import {
  AgentRouter,
  AuditEventTypes,
  ClaudeSdkAgentService,
  CodexAgentService,
  createDraftStore,
  createInvocationRecordStore,
  createSessionChainStore,
  createTurnExecutionStore,
  DeliveryCursorStore,
  getEventAuditLog,
  KimiAgentService,
  MemoryGovernanceStore,
  OpenCodeAgentService,
} from './domains/cats/services/index.js';
import { FileProfileRepository } from './domains/cats/services/profile/ProfileRepository.js';
import {
  getPushNotificationService,
  initPushNotificationService,
  resetPushNotificationService,
} from './domains/cats/services/push/PushNotificationService.js';
import {
  RuntimeSessionSealReaper,
  type RuntimeSessionSealReaperDrainResult,
  startSerializedRuntimeSessionSealReaperInterval,
} from './domains/cats/services/runtime-session/RuntimeSessionSealReaper.js';
import { createRuntimeSessionStore } from './domains/cats/services/runtime-session/RuntimeSessionStoreFactory.js';
import { ContextEpochOwner } from './domains/cats/services/session/context/ContextEpochOwner.js';
import {
  InMemoryPresentationLedgerStore,
  PresentationLedger,
} from './domains/cats/services/session/context/PresentationLedger.js';
import type { HandoffConfig } from './domains/cats/services/session/SessionSealer.js';
import { SessionSealer } from './domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from './domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from './domains/cats/services/session/TranscriptWriter.js';
import { createBacklogStore } from './domains/cats/services/stores/factories/BacklogStoreFactory.js';
import { createFrustrationIssueStore } from './domains/cats/services/stores/factories/FrustrationIssueStoreFactory.js';
import { createLabelStore } from './domains/cats/services/stores/factories/LabelStoreFactory.js';
import { createMemoryStore } from './domains/cats/services/stores/factories/MemoryStoreFactory.js';
import { createMessageStore } from './domains/cats/services/stores/factories/MessageStoreFactory.js';
import { createProfileUpdateProposalStore } from './domains/cats/services/stores/factories/ProfileUpdateProposalStoreFactory.js';
import { createProposalStore } from './domains/cats/services/stores/factories/ProposalStoreFactory.js';
import { createPushSubscriptionStore } from './domains/cats/services/stores/factories/PushSubscriptionStoreFactory.js';
import { createReadStateStore } from './domains/cats/services/stores/factories/ReadStateStoreFactory.js';
import { createSessionHandoffProposalStore } from './domains/cats/services/stores/factories/SessionHandoffProposalStoreFactory.js';
import { createSummaryStore } from './domains/cats/services/stores/factories/SummaryStoreFactory.js';
import { createTaskStore } from './domains/cats/services/stores/factories/TaskStoreFactory.js';
import { createThreadStore } from './domains/cats/services/stores/factories/ThreadStoreFactory.js';
import { createWorkflowSopStore } from './domains/cats/services/stores/factories/WorkflowSopStoreFactory.js';
import { InMemoryContextEpochStore } from './domains/cats/services/stores/ports/ContextEpochStore.js';
import { classifyInvocationRecoveryStatus } from './domains/cats/services/stores/ports/invocation-state-machine.js';
import type { MessageAppendListener, StoredMessage } from './domains/cats/services/stores/ports/MessageStore.js';
import type { TurnExecutionRecord } from './domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisContextEpochStore } from './domains/cats/services/stores/redis/RedisContextEpochStore.js';
import { RedisInvocationRecordStore } from './domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from './domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisPresentationLedgerStore } from './domains/cats/services/stores/redis/RedisPresentationLedgerStore.js';
import { userMentionEvent } from './domains/cats/services/stores/user-mention-index.js';
import { SkillConsumptionReceiptService } from './domains/cats/services/tool-usage/SkillConsumptionReceiptService.js';
import { DocumentListenRepository } from './domains/cats/services/tts/DocumentListenRepository.js';
import {
  resolveDocumentListenStatePath,
  resolveTtsCacheDir,
} from './domains/cats/services/tts/document-listen-paths.js';
import { MlxAudioTtsProvider } from './domains/cats/services/tts/MlxAudioTtsProvider.js';
import { initStreamingTtsRegistry } from './domains/cats/services/tts/StreamingTtsChunker.js';
import { TtsRegistry } from './domains/cats/services/tts/TtsRegistry.js';
import { startTtsCacheCleaner } from './domains/cats/services/tts/tts-cache-cleaner.js';
import { initVoiceBlockSynthesizer } from './domains/cats/services/tts/VoiceBlockSynthesizer.js';
import type { AgentService, ClaudeCompactionHooksFactory } from './domains/cats/services/types.js';
import { EntrustedWorkHumanTerminalService } from './domains/growing/EntrustedWorkHumanTerminalService.js';
import { EntrustedWorkLifecycleService } from './domains/growing/EntrustedWorkLifecycleService.js';
import {
  EntrustedWorkOwnerReadService,
  type PreparedArtifactReader,
} from './domains/growing/EntrustedWorkOwnerReadService.js';
import { EntrustedWorkTaskExecutionService } from './domains/growing/EntrustedWorkTaskExecutionService.js';
import { F232PreparedArtifactReader } from './domains/growing/F232PreparedArtifactReader.js';
import { F290CollectiveWorkResultPluginAdapter } from './domains/growing/F290CollectiveWorkResultPluginAdapter.js';
import { F246NeedsMeProducerAdapter, F306NeedsMeProducerAdapter } from './domains/growing/NeedsMeProducerAdapter.js';
import { NeedsMeProducerCatalog } from './domains/growing/NeedsMeProducerCatalog.js';
import { ActivityTracker } from './domains/health/ActivityTracker.js';
import { shouldTrackApiActivity } from './domains/health/activity-route-filter.js';
import { HumanDispositionFeedbackContextService } from './domains/human-disposition/HumanDispositionFeedbackContextService.js';
import { HumanDispositionLedger } from './domains/human-disposition/HumanDispositionLedger.js';
import { createDeferredPersonMemoryDailyTaskSpec } from './domains/memory/DeferredPersonMemoryDailyTaskSpec.js';
import { EntityRegistryStore } from './domains/memory/EntityRegistry.js';
import { EntityMemoryLifecycleService } from './domains/memory/entity/EntityMemoryLifecycleService.js';
import { EntityMemoryLifecycleStore } from './domains/memory/entity/EntityMemoryLifecycleStore.js';
import { sharedProactiveCandidateNudgeReceiptStore } from './domains/memory/entity-nudge-state.js';
import { createEventMemoryCorrectionProposalStore } from './domains/memory/event/createEventMemoryCorrectionProposalStore.js';
import { EventMemoryLifecycleService } from './domains/memory/event/EventMemoryLifecycleService.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
  RedisOwnerMemoryActionReceiptStore,
} from './domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { ProactiveCandidateRegistryResolver } from './domains/memory/ProactiveCandidateRegistryResolver.js';
import { ProactiveMemoryCandidateDetector } from './domains/memory/ProactiveMemoryCandidateDetector.js';
import { ProactiveMemoryNudgeService } from './domains/memory/ProactiveMemoryNudgeService.js';
import { PersonMemoryDispositionProofResolver } from './domains/memory/people/PersonMemoryDispositionProofResolver.js';
import { PersonMemoryDispositionSubjectProofResolver } from './domains/memory/people/PersonMemoryDispositionSubjectProofResolver.js';
import { PersonMemoryProposalStatusContextResolver } from './domains/memory/people/PersonMemoryProposalStatusContextResolver.js';
import { PersonMemoryRecallService } from './domains/memory/people/PersonMemoryRecallService.js';
import { RedisPersonMemoryStore } from './domains/memory/people/RedisPersonMemoryStore.js';
import { RedisWriteOpportunityDeliveryStore } from './domains/memory/people/RedisWriteOpportunityDeliveryStore.js';
import { RedisWriteOpportunityTerminalLedger } from './domains/memory/people/RedisWriteOpportunityTerminalLedger.js';
import { EvidenceStoreWorkspacePersonResolver } from './domains/memory/people/WorkspacePersonResolver.js';
import { refreshCanonicalProfileIndex } from './domains/memory/private-collection-bindings.js';
import { ProfileMemoryLifecycleService } from './domains/memory/profile/ProfileMemoryLifecycleService.js';
import { ProfileMemoryLifecycleStore } from './domains/memory/profile/ProfileMemoryLifecycleStore.js';
import { RedisDeferredPersonMemoryReceiptStore } from './domains/memory/RedisDeferredPersonMemoryReceiptStore.js';
import { createTasteProposalWriter } from './domains/memory/taste/createTasteProposalWriter.js';
import { TasteMemoryLifecycleService } from './domains/memory/taste/TasteMemoryLifecycleService.js';
import { TasteMemoryLifecycleStore } from './domains/memory/taste/TasteMemoryLifecycleStore.js';
import { TasteMemoryProjectionWriter } from './domains/memory/taste/TasteMemoryProjectionWriter.js';
import { importTasteTakeawayCandidates } from './domains/memory/taste/TasteTakeawayCandidateImporter.js';
import { tasteDocumentAnchor } from './domains/memory/taste/taste-memory-identity.js';
import { publicParticipantAvatar } from './domains/plugin/host-surface/public-participant-avatar.js';
import { PortDiscoveryService } from './domains/preview/port-discovery.js';
import { collectRuntimePorts } from './domains/preview/port-validator.js';
import { PreviewGateway } from './domains/preview/preview-gateway.js';
import { createRoutingContextRuntime } from './domains/routing-context/index.js';
import { DeploymentWaitStartGuard } from './domains/runtime-deployment/DeploymentWaitStartGuard.js';
import {
  beginOwnedRuntimeDeployment,
  type RuntimeDeploymentProcessContext,
} from './domains/runtime-deployment/RuntimeDeploymentBootstrap.js';
import { runtimeDeploymentSubjectRef } from './domains/runtime-deployment/RuntimeDeploymentObservationProvider.js';
import { readRuntimeServiceReadiness } from './domains/runtime-deployment/RuntimeDeploymentServiceReadiness.js';
import { MessageQueueRuntimeConversationReturnGateway } from './domains/runtime-interaction/MessageQueueRuntimeConversationReturnGateway.js';
import { createRuntimeInteractionRuntime } from './domains/runtime-interaction/runtime-interaction-composition.js';
import { appendServiceLog } from './domains/services/service-lifecycle.js';
import { FileTasteRepository } from './domains/taste/services/TasteRepository.js';
import { createVignetteWriter } from './domains/taste/services/writeVignette.js';
import { createTasteProposalStore } from './domains/taste/stores/factories/TasteProposalStoreFactory.js';
import { AgentPaneRegistry } from './domains/terminal/agent-pane-registry.js';
import { TmuxGateway } from './domains/terminal/tmux-gateway.js';
import { createDuckCapabilityPublicAdapter } from './infrastructure/capability-evolution/adapters/microduck-exploration/duck-capability-public-adapter.js';
import {
  createMicroduckApprovalResolver,
  createMicroduckProposalResolver,
} from './infrastructure/capability-evolution/adapters/microduck-governance-resolvers.js';
import { registerMicroduckLocalOwnerRuntime } from './infrastructure/capability-evolution/adapters/microduck-local-owner.js';
import { createMicroduckRuntimeAdapter } from './infrastructure/capability-evolution/adapters/microduck-owner-runtime.js';
import { ProgramAdapterRegistry } from './infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import { createHarnessHistoryGitSource } from './infrastructure/capability-evolution/adapters/request-review/harness-history-git-source.js';
import { HarnessHistoryPublicationOwner } from './infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.js';
import { RedisHarnessHistoryPublicationStore } from './infrastructure/capability-evolution/adapters/request-review/harness-history-publication-redis.js';
import { HarnessHistoryPublicationService } from './infrastructure/capability-evolution/adapters/request-review/harness-history-publication-service.js';
import { createRequestReviewOwnerAdapter } from './infrastructure/capability-evolution/adapters/request-review/request-review-owner-adapter.js';
import { RedisRequestReviewOwnerLedger } from './infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import {
  createRequestReviewCurrentVersionReader,
  createRequestReviewOwnerPort,
} from './infrastructure/capability-evolution/adapters/request-review/request-review-owner-port.js';
import { RequestReviewUseReceiptService } from './infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.js';
import {
  createRequestReviewVersionAttestor,
  requestReviewMountPointForClient,
} from './infrastructure/capability-evolution/adapters/request-review/request-review-version-attestor.js';
import { registerF311E0EvalRepairOwnerRuntime } from './infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-runtime-registration.js';
import { registerMicroduckEvalRepairOwnerRuntime } from './infrastructure/capability-evolution/change/microduck-eval-repair-owner-runtime-registration.js';
import type { EvolutionChangeOwnerPort } from './infrastructure/capability-evolution/change/program-change-owner-contract.js';
import { RequestReviewCanonicalRepairDispatcher } from './infrastructure/capability-evolution/change/request-review-canonical-dispatcher.js';
import { createRequestReviewDecisionOwner } from './infrastructure/capability-evolution/change/request-review-decision-owner.js';
import { loadRequestReviewEvalRepairOwnerBinding } from './infrastructure/capability-evolution/change/request-review-eval-repair-owner-binding.js';
import {
  createRequestReviewEvalRepairOwnerBindingProvider,
  resolveRequestReviewCurrentOwnerSnapshot,
} from './infrastructure/capability-evolution/change/request-review-eval-repair-owner-provider.js';
import { RequestReviewLineageBindingResolver } from './infrastructure/capability-evolution/change/request-review-lineage-binding-resolver.js';
import { createRequestReviewOwnerActions } from './infrastructure/capability-evolution/change/request-review-owner-actions.js';
import { RequestReviewOwnerFactAuthority } from './infrastructure/capability-evolution/change/request-review-owner-fact-authority.js';
import { RequestReviewOwnerReceiptService } from './infrastructure/capability-evolution/change/request-review-owner-receipts.js';
import { createRequestReviewCommitVersionVerifier } from './infrastructure/capability-evolution/change/request-review-owner-version-verifier.js';
import { CommandRegistry } from './infrastructure/commands/CommandRegistry.js';
import { parseManifestSlashCommands } from './infrastructure/commands/manifest-commands.js';
import type { EvalDomainId } from './infrastructure/harness-eval/domain/eval-domain-registry.js';
import { EvalRepairCaseActionResolver } from './infrastructure/harness-eval/eval-repair-case-action-resolver.js';
import type { EvalRepairOutcomeService } from './infrastructure/harness-eval/eval-repair-outcome.js';
import {
  createEvalRepairOwnerRuntime,
  evalRepairOwnerRuntimeRegistration,
} from './infrastructure/harness-eval/eval-repair-owner-runtime.js';
import { ensureEvalDomainThreads } from './infrastructure/harness-eval/hub/eval-hub-thread-ensure.js';
import { PawFeelBlockerReconciler } from './infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/blocker-reconciler.js';
import {
  LegacyPawFeelBlockerCensusService,
  loadOrCreateLegacyPawFeelBlockerCensusCursorSigner,
} from './infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.js';
import { PawFeelCanonicalResumeConditionResolver } from './infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/resume-condition-owner.js';
import { loadOrCreatePawFeelBundleSnapshotSigner } from './infrastructure/harness-eval/paw-feel-disposition/bundle-snapshot.js';
import { PawFeelContinuingResponsibilityResolver } from './infrastructure/harness-eval/paw-feel-disposition/continuation/follow-up-resolver.js';
import { PawFeelSourceCaseActionResolver } from './infrastructure/harness-eval/paw-feel-disposition/continuation/source-case-action-resolver.js';
import { RedisPawFeelReconciliationCoverageStore } from './infrastructure/harness-eval/paw-feel-disposition/coverage-store.js';
import { PawFeelDirectRepairBindingVerifier } from './infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-binding-verifier.js';
import { PawFeelDirectRepairFederation } from './infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.js';
import { PawFeelDirectRepairOutcomeResolver } from './infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-outcome-resolver.js';
import { PawFeelDirectRepairResolver } from './infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-resolver.js';
import {
  defaultPawFeelSourceToolClassifier,
  PawFeelDirectRepairSourceVerifier,
} from './infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-source.js';
import { RedisPawFeelDutyConfigStore } from './infrastructure/harness-eval/paw-feel-disposition/duty-config-store.js';
import { RedisPawFeelDutyNoticeWatermarkStore } from './infrastructure/harness-eval/paw-feel-disposition/duty-notice.js';
import { PawFeelDutyReceiptService } from './infrastructure/harness-eval/paw-feel-disposition/duty-receipt.js';
import { createPawFeelDutyTaskSpec } from './infrastructure/harness-eval/paw-feel-disposition/duty-task-spec.js';
import { RedisPawFeelDispositionEventLog } from './infrastructure/harness-eval/paw-feel-disposition/event-log.js';
import {
  captureAppendedPawFeelMessage,
  PawFeelCaptureIntentSidecar,
  PawFeelCaptureService,
} from './infrastructure/harness-eval/paw-feel-disposition/hot-intake.js';
import {
  loadOrCreatePawFeelInboxAuditCursorSigner,
  PawFeelInboxAuditScanService,
} from './infrastructure/harness-eval/paw-feel-disposition/inbox-audit-scan.js';
import { createMemoryCuePawFeelGitTruth } from './infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-git-truth.js';
import {
  MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE,
  MemoryCuePawFeelDirectRepairOwnerProvider,
} from './infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-owner-provider.js';
import { createTaskWorkflowPawFeelGitTruth } from './infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-git-truth.js';
import {
  TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE,
  TaskWorkflowPawFeelDirectRepairOwnerProvider,
} from './infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-owner-provider.js';
import { PawFeelDispositionReadModel } from './infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import { PawFeelDispositionReconciler } from './infrastructure/harness-eval/paw-feel-disposition/reconciler.js';
import { createPawFeelReconciliationTaskSpec } from './infrastructure/harness-eval/paw-feel-disposition/reconciliation-task-spec.js';
import { PawFeelFixEvidenceResolver } from './infrastructure/harness-eval/paw-feel-disposition/route-evidence-resolver.js';
import { PawFeelDispositionService } from './infrastructure/harness-eval/paw-feel-disposition/service.js';
import { registerMessageReadDiagnostics } from './infrastructure/message-read-diagnostics-plugin.js';
import { runSchedulerReplyUserIdBackfill } from './infrastructure/scheduler/scheduler-reply-userid-backfill.js';
import { securityHeadersPlugin } from './infrastructure/security-headers.js';
import { sessionAuthPlugin, sessionRoute } from './infrastructure/session-auth.js';
import { startupMilestone } from './infrastructure/startup-diagnostics.js';
import { startProcessCpuCapture } from './infrastructure/telemetry/cpu/process-cpu-capture.js';
import { SocketManager } from './infrastructure/websocket/index.js';
import { avatarsRoutes } from './routes/avatars.js';
import {
  appendA2ASourceWithLedgerAdmission,
  commitRecoveredFailedResponse,
  enqueueA2ATargets,
  planA2AFanoutAdmission,
} from './routes/callback-a2a-trigger.js';
import { CallbackAuthSystemMessageNotifier } from './routes/callback-auth-system-message.js';
import {
  cancelManagedWakeIfTaskMatches,
  commitManagedWakeCancellation,
  isManagedWakeRunnerActive,
  releaseManagedWakeCancellation,
  reserveManagedWakeCancellation,
} from './routes/callback-hold-ball-routes.js';
import type { CallbackMemoryCueDeps } from './routes/callback-memory-cue-routes.js';
import { callbackProposeEntityRoutes } from './routes/callback-propose-entity-routes.js';
import { callbackProposeEventMemoryCorrectionRoutes } from './routes/callback-propose-event-memory-correction-routes.js';
import { callbackProposeTasteRoutes } from './routes/callback-propose-taste-routes.js';
import { callbackRuntimeInteractionRoutes } from './routes/callback-runtime-interaction-routes.js';
import { configSecretsRoutes } from './routes/config-secrets.js';
import { dispatchProposalRoutes } from './routes/dispatch-proposal-routes.js';
import { entityMemoryOwnerRoutes } from './routes/entity-memory-owner.js';
import { readEntityMemorySource } from './routes/entity-memory-source.js';
import { buildEntityRecord, registerEntityProposalDecisionRoutes } from './routes/entity-proposal-decision-routes.js';
import { evalRepairApprovalRoutes } from './routes/eval-repair-approval-routes.js';
import { evalRepairOutcomeRoutes } from './routes/eval-repair-outcome-routes.js';
import { registerEventMemoryCorrectionDecisionRoutes } from './routes/event-memory-correction-decision-routes.js';
import { readEventMemorySource } from './routes/event-memory-source.js';
import { harnessHistoryRoutes } from './routes/harness-history-routes.js';
import { registerHumanDispositionFeedbackRoutes } from './routes/human-disposition-feedback-routes.js';
import {
  accountsRoutes,
  agentHooksRoutes,
  approvalHubRoutes,
  audioProxyRoutes,
  auditRoutes,
  backlogRoutes,
  bootcampRoutes,
  brakeRoutes,
  callbacksRoutes,
  capabilitiesRoutes,
  capabilityEvolutionProgramRoutes,
  capabilitySnapshotRoutes,
  catsRoutes,
  claudeRescueRoutes,
  commandsRoutes,
  conciergeRoutes,
  configRoutes,
  debugInvocationExportRoutes,
  distillationOpportunityRoutes,
  distillationRoutes,
  dossierDistillationRoutes,
  dossierObservationRoutes,
  dossierRoutes,
  eventsRoutes,
  evidenceRoutes,
  executionDigestRoutes,
  exportRoutes,
  externalProjectRoutes,
  externalRuntimeSessionsRoutes,
  featTrajectoryRoutes,
  featureDocDetailRoutes,
  firstRunQuestRoutes,
  frustrationIssueRoutes,
  governanceStatusRoute,
  guideActionRoutes,
  homeStateRoutes,
  intentCardRoutes,
  invocationsRoutes,
  labelsRoutes,
  leaderboardEventsRoutes,
  leaderboardRoutes,
  libraryRoutes,
  memoryPublishRoutes,
  memoryRoutes,
  messageActionsRoutes,
  messageBundleRoutes,
  messagesRoutes,
  mkdirRoute,
  packsRoutes,
  pawFeelDispositionRoutes,
  pawFeelInboxAuditScanRoutes,
  pawFeelLegacyCensusRoutes,
  perspectiveRoutes,
  projectSetupRoute,
  projectsBootstrapRoutes,
  projectsRoutes,
  promptInjectionManifestRoutes,
  promptInjectionPreviewRoutes,
  promptInjectionRoutes,
  proposalRoutes,
  pushRoutes,
  queueRoutes,
  quotaRoutes,
  recallMetricsRoutes,
  refAudioUploadRoutes,
  reflectRoutes,
  refluxRoutes,
  registerCallbackAuthDebugRoute,
  registerCallbackDocsRoutes,
  registerCustodyOfferRoutes,
  registerDeploymentWaitProjectionRoutes,
  registerEntrustedWorkReadRoutes,
  registerProfileUpdateDecisionRoutes,
  resolutionRoutes,
  routingContextRoutes,
  routingPreviewRoutes,
  rulesRoutes,
  runtimeInteractionRoutes,
  servicesRoutes,
  sessionChainRoutes,
  sessionHandoffApproveRoutes,
  sessionHooksRoutes,
  sessionStrategyConfigRoutes,
  sessionTranscriptRoutes,
  signalCollectionRoutes,
  signalPodcastRoutes,
  signalStudyRoutes,
  signalsRoutes,
  skillsRoutes,
  skillsWriteRoutes,
  sliceRoutes,
  summariesRoutes,
  tasksRoutes,
  threadBranchRoutes,
  threadCatsRoutes,
  threadsRoutes,
  tipTelemetryRoutes,
  toolUsageRoutes,
  ttsRoutes,
  uploadsRoutes,
  usageRoutes,
  workflowSopRoutes,
  workspaceEditRoutes,
  workspaceGitRoutes,
  workspaceRoutes,
  worldRoutes,
} from './routes/index.js';
import { knowledgeFeedRoutes } from './routes/knowledge-feed.js';
import { createLiveTaskAuthority } from './routes/live-task-authority.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { mediaRoutes } from './routes/media-routes.js';
import { registerMemberMcpRoutes, resolveMemberToolFamiliesForCat } from './routes/member-mcp.js';
import { registerPersonMemoryDecisionRoutes } from './routes/person-memory-decision-routes.js';
import { personMemoryOwnerReadRoutes } from './routes/person-memory-owner-read.js';
import { previewRoutes } from './routes/preview.js';
import { profileMemoryOwnerRoutes } from './routes/profile-memory-owner.js';
import { resolveActiveInvocations } from './routes/queue.js';
import { runtimeDeploymentRoutes } from './routes/runtime-deployment-routes.js';
import { createSessionCompactionSurface } from './routes/session-compaction-surface.js';
import { createSealOnPreCompact } from './routes/session-seal-handler.js';
import { registerTasteProposalDecisionRoutes } from './routes/taste-proposal-decision-routes.js';
import { terminalRoutes } from './routes/terminal.js';
import { threadExportRoutes } from './routes/thread-export.js';
import { threadMemberEffortRoutes } from './routes/thread-member-effort.js';
import { threadMemberSpeedRoutes } from './routes/thread-member-speed.js';
import { threadMemberStrategyRoutes } from './routes/thread-member-strategy.js';
import { registerWaitTerminationRoutes } from './routes/wait-termination-routes.js';
import { ApiInstanceLease, type ApiInstanceLeaseInvalidation } from './services/ApiInstanceLease.js';
import { resolveActiveProjectRoot } from './utils/active-project-root.js';
import { createCliExecutionOwnerService } from './utils/cli-process-ownership.js';
import { resolveMemoryRepoPaths } from './utils/memory-root.js';
import { findMonorepoRoot } from './utils/monorepo-root.js';
import { emitQueueUpdated } from './utils/queue-enrichment.js';
import { resolveUserId } from './utils/request-identity.js';
import { buildSkillMountTargets } from './utils/skill-mount.js';
import { resolveCatCafeSkillsSource } from './utils/skill-source.js';
import { buildThreadDeepLink } from './utils/thread-deep-link.js';
import { getDefaultConnectorMediaDir, getDefaultUploadDir } from './utils/upload-paths.js';

const PORT = parseInt(process.env.API_SERVER_PORT ?? String(deploymentDefaults.apiPort), 10);
const HOST = process.env.API_SERVER_HOST ?? '127.0.0.1';

let socketManager: SocketManager | null = null;
let redisClient: RedisClient | null = null;
let burnRateMonitor: { start(): void; stop(): void } | null = null;

/**
 * Get the SocketManager instance
 * @throws Error if SocketManager is not initialized
 */
export function getSocketManager(): SocketManager {
  if (!socketManager) {
    throw new Error('SocketManager not initialized');
  }
  return socketManager;
}

const PROCESS_START_AT = Date.now();
let recordRuntimeStartupFailure: ((reason: string) => Promise<void>) | null = null;

// Guard against a stray SIGUSR1 opening the V8 inspector. Node's default
// SIGUSR1 handler starts the debugger; on Node 24 + tsx, a subsequent debugger
// attach/detach crashes the process with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
// (taking the API down with ELIFECYCLE exit 1). Installing our own listener
// overrides that default so the inspector never auto-opens. Logged so a stray
// signal still leaves a forensic trace if it ever recurs.
process.on('SIGUSR1', () => {
  console.warn('[api] Ignoring SIGUSR1 — inspector auto-open suppressed (see index.ts guard)');
});

function hasRuntimeSessionDrain(service: AgentService): service is AgentService & {
  drainRuntimeSession(runtimeSessionId: string): Promise<RuntimeSessionSealReaperDrainResult>;
} {
  return typeof (service as { drainRuntimeSession?: unknown }).drainRuntimeSession === 'function';
}

async function main(): Promise<void> {
  startupMilestone('module-graph-loaded');
  const acpHostPolicy = resolveAcpHostPolicy();
  let managedCommandWakeRecovery: ManagedCommandWakeRecoverySweep | undefined;
  const { logger: customLogger, isDebugMode, LOG_DIR_PATH } = await import('./infrastructure/logger.js');
  let sessionHookAuthenticationReady = (): boolean => false;

  // F152: Initialize OpenTelemetry SDK (must be early, before routes)
  const { initTelemetry } = await import('./infrastructure/telemetry/init.js');
  const telemetryHandle = initTelemetry();
  startupMilestone('telemetry-ready');

  const { registerMemberSaveDiagnostics } = await import('./routes/member-save-diagnostics.js');
  const { registerConnectionDiagnostics } = await import('./routes/connection-diagnostics.js');
  const { saveSpan } = await import('./utils/member-save-diagnostics.js');

  const app = Fastify({ logger: customLogger as unknown as import('fastify').FastifyBaseLogger });
  reportAcpHostPolicy(app.log, acpHostPolicy);
  const messageReadDiagnostics = registerMessageReadDiagnostics(app);
  const privateUserId = (process.env.CAT_CAFE_USER_ID ?? 'default-user').trim();
  let approvalDecisionReceipts: ApprovalDecisionReceiptService;
  installApprovalDecisionReceiptHooks(app, () => approvalDecisionReceipts);
  let runtimeDeploymentRevision: string | null = null;
  let runtimeDeploymentContext: RuntimeDeploymentProcessContext | undefined;
  const deploymentWaitLifecycleHolder: {
    current?: import('./domains/runtime-deployment/DeploymentWaitLifecycleService.js').DeploymentWaitLifecycleService;
  } = {};
  let runDeploymentWaitRecovery = async (): Promise<void> => {};
  let deploymentWaitRecoveryLoop:
    | import('./domains/runtime-deployment/DeploymentWaitRecoverySweep.js').DeploymentWaitRecoverySweep
    | undefined;
  app.addHook('onClose', () => deploymentWaitRecoveryLoop?.stopPeriodic());
  const declaredRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
  const declaredDeploymentId = process.env.CAT_CAFE_DEPLOYMENT_ID;
  const runtimeEntrypointRoot = findMonorepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (!privateUserId) throw new Error('[api] CAT_CAFE_USER_ID must not be blank');

  if (isDebugMode) {
    app.log.info({ logDir: LOG_DIR_PATH }, '[api] Debug mode enabled (--debug flag)');
  }

  // CORS for frontend
  await app.register(cors, {
    origin: resolveFrontendCorsOrigins(process.env, app.log),
    credentials: true,
    exposedHeaders: ['x-clowder-save-id'],
    // Diagnostic correlation adds a fixed header to GETs; reuse their preflight during polling.
    maxAge: 600,
  });

  // F156 D-2: Anti-clickjacking headers (X-Frame-Options + CSP frame-ancestors)
  await app.register(securityHeadersPlugin);

  // F156 D-1: Cookie parsing + session-based identity (replaces userId self-reporting)
  await app.register(fastifyCookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: privateUserId });
  registerMemberSaveDiagnostics(app, runtimeDeploymentRevision ?? undefined);
  registerConnectionDiagnostics(app);

  // WebSocket support (F089 terminal)
  await app.register(fastifyWebsocket);

  // Prevent Fastify from intercepting Socket.IO paths — Socket.IO handles
  // them via its own http server listeners (both polling and WebSocket).
  // Without this, @fastify/websocket causes Fastify to send 404 for
  // /socket.io/ upgrade requests, killing WebSocket transport entirely.
  app.addHook('onRequest', (_request, reply, done) => {
    if (_request.url.startsWith('/socket.io/')) {
      reply.hijack();
    }
    done();
  });

  // Health check. Keep root paths for direct API access and expose /api/*
  // aliases for same-origin reverse-proxy deployments.
  let callbackAuthCapability: {
    backend: 'initializing' | 'redis' | 'memory';
    durability: 'initializing' | 'durable' | 'degraded_memory';
  } = { backend: 'initializing', durability: 'initializing' };
  const healthHandler = async () => ({
    status: 'ok' as const,
    timestamp: Date.now(),
    deploymentRevision: runtimeDeploymentRevision,
    ...(runtimeDeploymentContext
      ? {
          deploymentSubjectRef: runtimeDeploymentSubjectRef(
            runtimeDeploymentContext.installationId,
            runtimeDeploymentContext.deploymentId,
          ),
          deploymentBootId: runtimeDeploymentContext.bootId,
          deploymentBootSequence: runtimeDeploymentContext.bootSequence,
        }
      : {}),
    callbackAuth: callbackAuthCapability,
  });
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // F152: Readiness check — verifies dependencies are reachable.
  // evidenceStoreRef is set after memoryServices init; handler runs at request time.
  let evidenceStoreRef: { health(): Promise<boolean> } | null = null;
  async function checkReadiness(): Promise<{
    status: 'ready' | 'degraded';
    checks: Record<string, { ok: boolean; ms: number; error?: string }>;
  }> {
    const checks: Record<string, { ok: boolean; ms: number; error?: string }> = {};
    if (redisClient) {
      const t0 = Date.now();
      try {
        await redisClient.ping();
        checks.redis = { ok: true, ms: Date.now() - t0 };
      } catch (err) {
        checks.redis = { ok: false, ms: Date.now() - t0, error: String(err) };
      }
    } else {
      checks.redis = { ok: true, ms: 0 };
    }
    if (evidenceStoreRef) {
      const t0 = Date.now();
      try {
        const ok = await evidenceStoreRef.health();
        checks.sqlite = { ok, ms: Date.now() - t0, ...(ok ? {} : { error: 'SELECT 1 failed' }) };
      } catch (err) {
        checks.sqlite = { ok: false, ms: Date.now() - t0, error: String(err) };
      }
    }
    checks.sessionHooks = { ok: sessionHookAuthenticationReady(), ms: 0 };
    const allOk = Object.values(checks).every((c) => c.ok);
    return { status: allOk ? 'ready' : 'degraded', checks };
  }
  const readyHandler = async (_request: unknown, reply: FastifyReply) => {
    const result = await checkReadiness();
    if (result.status !== 'ready') reply.code(503);
    return { ...result, timestamp: Date.now() };
  };
  app.get('/ready', readyHandler);
  app.get('/api/ready', readyHandler);

  // Create invocation tracker for cancellation support
  const invocationTracker = new InvocationTracker();
  let router!: AgentRouter;

  // Initialize WebSocket manager BEFORE routes (injected via opts, no circular import).
  // IMPORTANT: Socket.io must attach to the SAME server Fastify listens on.
  socketManager = new SocketManager(app.server, invocationTracker);

  // F063: Workspace file change watcher — pushes file-changed events to clients
  const { setupWorkspaceFileWatcher } = await import('./domains/workspace/workspace-file-watcher.js');
  setupWorkspaceFileWatcher(socketManager.getIO());

  // F153 Phase E L3: Burn-rate alerting — push system_notice via WebSocket
  if (telemetryHandle.getMetricsText) {
    const { BurnRateMonitor } = await import('./infrastructure/telemetry/burn-rate-monitor.js');
    burnRateMonitor = new BurnRateMonitor({
      getMetricsText: telemetryHandle.getMetricsText,
      onAlert: (alerts) => {
        const lines = alerts.map((a) => `${a.metric}: ${a.currentValue.toFixed(2)} (threshold: ${a.threshold})`);
        socketManager?.broadcastToRoom('workspace:global', 'connector_message', {
          message: {
            type: 'connector',
            content: `[Telemetry Alert] Thresholds exceeded:\n${lines.join('\n')}`,
            source: { presentation: 'system_notice', noticeTone: 'warning' },
            timestamp: Date.now(),
          },
        });
      },
      onClear: () => {
        socketManager?.broadcastToRoom('workspace:global', 'connector_message', {
          message: {
            type: 'connector',
            content: '[Telemetry] All metrics recovered to normal levels.',
            source: { presentation: 'system_notice', noticeTone: 'info' },
            timestamp: Date.now(),
          },
        });
      },
    });
    burnRateMonitor.start();
  }

  // Create shared service instances for MCP callback flow
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? createRedisClient({ url: redisUrl }) : undefined;
  redisClient = redis ?? null;

  let apiInstanceLease: ApiInstanceLease | undefined;
  let shutdownForLeaseLoss: ((signal: string) => Promise<void>) | null = null;
  let forcedLeaseLossExitTimer: ReturnType<typeof setTimeout> | null = null;
  const handleLeaseInvalidation = (event: ApiInstanceLeaseInvalidation): void => {
    const errorDetail = event.error ? ` error=${String(event.error)}` : '';
    app.log.error(
      `[api] API namespace lease invalidated (${event.reason}) for ${event.holder.instanceId} pid=${event.holder.pid} host=${event.holder.hostname} port=${event.holder.apiPort}; shutting down to preserve Redis singleton.${errorDetail}`,
    );
    if (!forcedLeaseLossExitTimer) {
      forcedLeaseLossExitTimer = setTimeout(() => {
        app.log.error('[api] Lease-loss shutdown timed out; forcing process exit');
        process.exit(1);
      }, 5_000);
      forcedLeaseLossExitTimer.unref?.();
    }
    if (shutdownForLeaseLoss) {
      void shutdownForLeaseLoss(`API_INSTANCE_LEASE_${event.reason.toUpperCase()}`);
      return;
    }
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };
  if (redis) {
    apiInstanceLease = new ApiInstanceLease(redis, {
      apiPort: PORT,
      cwd: process.cwd(),
      startedAt: PROCESS_START_AT,
      onLeaseInvalidated: handleLeaseInvalidation,
    });
    const leaseResult = await apiInstanceLease.acquire();
    if (!leaseResult.acquired) {
      await apiInstanceLease.release().catch(() => {});
      await redis.quit().catch(() => {});
      const holder = leaseResult.holder;
      const holderHint = holder
        ? ` holder=${holder.instanceId} pid=${holder.pid} host=${holder.hostname} port=${holder.apiPort}`
        : '';
      throw new Error(`[api] Redis namespace already has a live API instance; refusing to start.${holderHint}`);
    }
    app.log.info(
      `[api] API namespace lease acquired (${leaseResult.holder?.instanceId ?? 'unknown'}) on redis=${redisUrl ?? 'memory'}`,
    );
  }

  if (declaredRuntimeRoot && declaredDeploymentId) {
    try {
      const dataRoot = process.env.CAT_CAFE_DATA_DIR ?? join(homedir(), '.cat-cafe');
      const context = await beginOwnedRuntimeDeployment({
        runtimeRoot: declaredRuntimeRoot,
        entrypointRoot: runtimeEntrypointRoot,
        deploymentId: declaredDeploymentId,
        dataRoot,
        currentReadyServices: () =>
          readRuntimeServiceReadiness({
            isApiReady: async () => (await checkReadiness()).status === 'ready',
            webPort: Number(process.env.CAT_CAFE_RUNTIME_WEB_PORT),
          }),
      });
      if (context) {
        runtimeDeploymentContext = context;
        runtimeDeploymentRevision = context.runningRevision;
        recordRuntimeStartupFailure = async (reason) => {
          await context.ledger.recordStartupFailure({
            deploymentId: context.deploymentId,
            bootId: context.bootId,
            reason,
          });
        };
      } else {
        app.log.warn('[F323] inherited deployment coordinates do not own the loaded API entrypoint; ledger disabled');
      }
    } catch (error) {
      app.log.error({ error }, '[F323] runtime deployment ledger unavailable; deployment waits fail closed');
    }
  }

  // F085 Phase 4+6: Platform-level activity tracker (hyperfocus brake)
  // Phase 6: pass Redis for TD110 settings persistence; init() loads from Redis
  const activityTracker = new ActivityTracker({ redis: redis ?? undefined });
  await activityTracker.init();
  app.addHook('onRequest', (request, _reply, done) => {
    // Skip non-user API paths and brake endpoints (avoid trigger-on-checkin loop)
    if (!shouldTrackApiActivity(request.url)) {
      done();
      return;
    }
    const userId = resolveUserId(request);
    if (userId) {
      activityTracker.recordActivity(userId);
      // shouldTrigger reads per-user settings (enabled + threshold) internally
      const level = activityTracker.shouldTrigger(userId);
      if (level > 0 && socketManager) {
        activityTracker.markTriggered(userId, level as 1 | 2 | 3);
        socketManager.emitToUser(userId, 'brake:trigger', {
          level,
          activeMinutes: Math.round(activityTracker.getState(userId).activeWorkMs / 60_000),
          nightMode: ActivityTracker.isNightMode(),
          // Phase 6: modal needs the user's mode at trigger time (settings panel may never have been opened)
          mode: activityTracker.getSettings(userId).mode,
          timestamp: Date.now(),
        });
      }
    }
    done();
  });

  // F167 Phase O PR-O5: wire Redis-backed grounding sample store (8-day TTL).
  // Falls back to in-memory if Redis unavailable.
  if (redis) {
    const { wireRedisGroundingSampleStore } = await import('./infrastructure/grounding/grounding-sample-singleton.js');
    wireRedisGroundingSampleStore(redis);
  }

  // F237: bootstrap injection trace store (fail-open — no Redis → no traces)
  if (redis) {
    const { bootstrapTraceStore } = await import('./domains/prompt-hooks/trace-bootstrap.js');
    bootstrapTraceStore(redis);
  }

  // F298 Phase A: callback auth is bound to the same exact child execution.
  // Redis is the durable default; memory requires explicit opt-in and reports
  // degraded capability rather than pretending restart safety.
  const configuredTombstoneGcTtlMs = Number.parseInt(
    process.env.CAT_CAFE_AUTH_TOMBSTONE_GC_TTL_MS ?? String(30 * 24 * 60 * 60 * 1000),
    10,
  );
  if (!Number.isSafeInteger(configuredTombstoneGcTtlMs) || configuredTombstoneGcTtlMs <= 0) {
    throw new Error('CAT_CAFE_AUTH_TOMBSTONE_GC_TTL_MS must be a positive safe integer');
  }
  const canonicalTurnExecutionStore = createTurnExecutionStore(redis);
  const onCallbackAuthLifecycleSignal = (signal: CallbackAuthLifecycleSignal): void => {
    app.log.warn({ callbackAuthLifecycle: signal }, '[api] Callback auth lifecycle divergence detected');
  };
  const registryBackendKind = selectInvocationBackendKind(process.env.CAT_CAFE_INVOCATION_REGISTRY, !!redis);
  const registry =
    registryBackendKind === 'redis' && redis
      ? new InvocationRegistry({
          backend: new (
            await import('./domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js')
          ).RedisAuthInvocationBackend(redis, { tombstoneGcTtlMs: configuredTombstoneGcTtlMs }),
          startupRecoveryRequired: true,
          turnExecutionStore: canonicalTurnExecutionStore,
          onLifecycleSignal: onCallbackAuthLifecycleSignal,
        })
      : new InvocationRegistry({
          tombstoneGcTtlMs: configuredTombstoneGcTtlMs,
          turnExecutionStore: canonicalTurnExecutionStore,
          onLifecycleSignal: onCallbackAuthLifecycleSignal,
        });
  const turnExecutionStore = new CallbackAuthTurnExecutionLifecycle(canonicalTurnExecutionStore, registry);
  callbackAuthCapability = callbackAuthCapabilityForBackend(registryBackendKind);
  sessionHookAuthenticationReady = () => registry.isStartupRecoveryComplete();
  app.log.info({ callbackAuth: callbackAuthCapability }, '[api] InvocationRegistry initialized');

  const { AgentKeyRegistry } = await import('./domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
  const agentKeyRegistryBackendKind = redis ? 'redis' : 'memory';
  const agentKeyRegistry =
    agentKeyRegistryBackendKind === 'redis' && redis
      ? new AgentKeyRegistry({
          backend: new (
            await import('./domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js')
          ).RedisAgentKeyBackend(redis),
        })
      : new AgentKeyRegistry();
  app.log.info(`[api] AgentKeyRegistry initialized (${agentKeyRegistryBackendKind} backend)`);
  let ownsGlobalAgentKeySidecars = false;
  let agentKeySidecarRenewalLoop: { start(): void; stop(): Promise<void> } | null = null;
  try {
    const { shouldProvisionGlobalAgentKeySidecars } = await import(
      './domains/cats/services/agents/agent-key/agent-key-sidecar-policy.js'
    );
    ownsGlobalAgentKeySidecars = shouldProvisionGlobalAgentKeySidecars({
      backendKind: agentKeyRegistryBackendKind,
    });
  } catch (err) {
    app.log.warn(`[api] Global agent-key sidecar eligibility unavailable: ${String(err)}`);
  }

  // Fail-closed: refuse to start without Redis unless explicitly opted into memory mode.
  // Also verify Redis is actually reachable (PING), not just configured.
  if (redis) {
    try {
      await redis.ping();
      app.log.info('[api] Redis PING OK');
    } catch (err) {
      await redis.quit().catch(() => {});
      throw new Error(
        `[api] Redis PING failed: ${err instanceof Error ? err.message : err}. ` +
          'Check REDIS_URL or set MEMORY_STORE=1 for memory mode.',
      );
    }
  }
  const storageResult = assertStorageReady(!!redis);
  app.log.info(`[api] Storage mode: ${storageResult.mode}`);
  const { systemStatusRoutes } = await import('./routes/system-status.js');
  await app.register(systemStatusRoutes, { storageMode: storageResult.mode });

  // F102 KD-34: append listener placeholder (wired after memoryServices init)
  let appendListener: MessageAppendListener | null = null;
  let projectMessageProducer:
    | ((message: import('./domains/cats/services/stores/ports/MessageStore.js').StoredMessage) => Promise<void>)
    | undefined;
  let custodyOpportunityObservation:
    | ReturnType<typeof import('./domains/growing/CustodyOpportunityRuntime.js').startCustodyOpportunityObservation>
    | undefined;

  const rawMessageStore = createMessageStore(redis, {
    readDiagnostics: messageReadDiagnostics,
    onAppend: (msg) => {
      appendListener?.(msg);
      if (userMentionEvent(msg) || hasRecentWorkPublication(msg))
        socketManager?.emitToUser(msg.userId, 'entrusted_work_projection_invalidated', { ownerUserId: msg.userId });
      custodyOpportunityObservation?.notifySourceChanged(msg);
    },
  });
  const messagingStores = createMessagingStores(redis);
  const subscriptionDrainScheduler = new SubscriptionDrainScheduler((error, threadId) => {
    app.log.error({ error, threadId }, '[messaging] subscriber delivery drain failed');
  });
  // W2-5b: bound once the media ledger and TTS exist (below); until then media blocks publish as before.
  let outboundMediaPublication: OutboundMediaPublication | undefined;
  const messageStore = createPublishingMessageStore(rawMessageStore, {
    events: messagingStores.events,
    publications: messagingStores.publications,
    outboundMedia: () => outboundMediaPublication,
    onPublished: subscriptionDrainScheduler.schedule,
    onPublishFailure: (error, stored) => {
      app.log.error(
        { error, messageId: stored.id, threadId: stored.threadId },
        '[messaging] publish failed; subscribers will not see this message',
      );
    },
  });
  const runtimeInteractionRuntime = await createRuntimeInteractionRuntime({
    ...(redis ? { redis } : {}),
    messageStore,
    socketManager,
    onSweepError: (error) => app.log.warn({ error }, '[F306] Conversation decision recovery sweep failed'),
  });
  if (runtimeInteractionRuntime.startupInvalidated.length > 0) {
    app.log.warn(
      { count: runtimeInteractionRuntime.startupInvalidated.length },
      '[api] Invalidated orphaned runtime interactions from an earlier host epoch',
    );
  }
  await app.register(runtimeInteractionRoutes, { service: runtimeInteractionRuntime.service });

  const queueLedgerStore = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
  const invocationQueue = new InvocationQueue(queueLedgerStore, {
    projectRoot: resolveActiveProjectRoot(),
    invocationTracker,
    resolveCarrierCapability: (catId) => router?.freshnessCarrierCapability(catId),
    resolveTargets: (requested, threadId, content, exact) =>
      router.resolveSendTargets(requested, threadId, content, exact),
    onAdmitted: ({ threadId, message, entries }) => {
      if (message && entries.some((entry) => entry.sourceCategory !== 'a2a_failure'))
        queueProcessor.registerCallerDispatchInitialTargets(
          message,
          entries.flatMap((entry) => entry.targets),
        );
      void queueProcessor.requestDrain(threadId).catch((err) => app.log.error({ err, threadId }, 'send drain failed'));
    },
  });
  await invocationQueue.hydrateFromLedger(messageStore);
  const invocationRecordStore = createInvocationRecordStore(redis);
  const sessionStore = redis ? new SessionStore(redis) : undefined;
  // #1200 P2-3: wire cursor canonicalizer for v1→v2 async resolution
  const cursorCanonicalizer = messageStore.canonicalizeCursor
    ? (msgId: string, threadId: string) => Promise.resolve(messageStore.canonicalizeCursor!(msgId, threadId))
    : undefined;
  const deliveryCursorStore = new DeliveryCursorStore(sessionStore, cursorCanonicalizer);
  const threadStore = createThreadStore(redis);
  const proposalStore = createProposalStore(redis);
  const handoffProposalStore = createSessionHandoffProposalStore(redis);
  // F246 Phase B: dispatch proposal store for assign_work effect-class approvals
  // Redis-backed when available: persists held messages across API restarts (P1-2 review fix)
  const dispatchProposalStore = createDispatchProposalStore(redis);
  // F231 KD-19: profile-update proposals + per-target write lock + canonical user profile repository.
  const profileUpdateProposalStore = createProfileUpdateProposalStore(redis);
  const profileUpdateLock = new SessionMutex();
  const profileRepository = new FileProfileRepository();
  const frustrationIssueStore = createFrustrationIssueStore(redis);
  // F260 Phase A: entity proposal store (Redis when available — Iron Law #5)
  const entityProposalStore = createEntityProposalStore(redis);
  // F221 Phase B: taste proposal store (InMemory now; Redis in Task 3)
  const tasteProposalStore = createTasteProposalStore(redis);
  const eventMemoryCorrectionProposalStore = createEventMemoryCorrectionProposalStore(redis);
  const tasteRepository = new FileTasteRepository(findMonorepoRoot(process.cwd()));
  const tasteApprovalCoordinator = {
    lock: new SessionMutex(),
    lockKey: () => tasteRepository.approvalLockKey(),
  };
  const ownerMemoryActionCoordinator = new OwnerMemoryActionCoordinator({
    store: redis ? new RedisOwnerMemoryActionReceiptStore(redis) : new InMemoryOwnerMemoryActionReceiptStore(),
    lock: new SessionMutex(),
  });

  // F155 B-4/B-6: Guide state is runtime-only (in-memory, resets on restart)
  const { InMemoryGuideSessionStore } = await import('./domains/guides/GuideSessionRepository.js');
  const guideSessionStore = new InMemoryGuideSessionStore();
  const { InMemoryGuideDismissTracker } = await import('./domains/guides/GuideDismissTracker.js');
  const dismissTracker = new InMemoryGuideDismissTracker();
  let taskStore = createTaskStore(redis);
  const labelStore = createLabelStore(redis);
  let actionSuccessorLeaseStore:
    | import('./domains/ball-custody/RedisActionSuccessorLeaseStore.js').RedisActionSuccessorLeaseStore
    | undefined;
  let actionSuccessorAdmissionService:
    | import('./domains/ball-custody/ActionSuccessorAdmissionService.js').ActionSuccessorAdmissionService
    | undefined;
  let dispatchActionApprovalService:
    | import('./domains/approval-hub/DispatchActionApprovalService.js').DispatchActionApprovalService
    | undefined;
  let actionSuccessorRecovery:
    | import('./domains/ball-custody/ActionSuccessorRecoverySweep.js').ActionSuccessorRecoverySweep
    | undefined;
  let actionSubjectTruthResolver:
    | import('./domains/ball-custody/ActionSubjectTruthResolver.js').ActionSubjectTruthResolver
    | undefined;
  let taskApprovedDelegateProvider:
    | import('./domains/ball-custody/action-subject-delegate-contract.js').TaskApprovedDelegateProvider
    | undefined;
  let actionSuccessorCompletionService:
    | import('./domains/ball-custody/ActionSuccessorCompletionService.js').ActionSuccessorCompletionService
    | undefined;
  let taskActionSuccessorLifecycle:
    | import('./domains/ball-custody/TaskActionSuccessorLifecycle.js').TaskActionSuccessorLifecycle
    | undefined;
  let taskActionSuccessorOrphanRecovery:
    | import('./domains/ball-custody/TaskActionSuccessorOrphanRecovery.js').TaskActionSuccessorOrphanRecovery
    | undefined;
  // F233 Phase B (B2): ball-custody ingest（fire-and-forget 旁路写球权事件，注入 AgentRouter）
  let ballCustodyIngest: import('./domains/ball-custody/BallCustodyIngest.js').BallCustodyIngest | undefined;
  let ballCustodyProjector: import('./domains/ball-custody/BallCustodyProjector.js').BallCustodyProjector | undefined;
  let ballCustodyProjectionStore:
    | import('./domains/ball-custody/BallCustodyProjectionStore.js').IBallCustodyProjectionStore
    | undefined;
  let ballCustodyEventLog: import('./domains/ball-custody/BallCustodyEventLog.js').IBallCustodyEventLog | undefined;
  if (redis) {
    const [
      actionStoreMod,
      actionTruthMod,
      actionAdmissionMod,
      actionCompletionMod,
      actionProjectionRetirementMod,
      taskActionLifecycleMod,
      proposalDelegateMod,
      orphanAtomicStoreMod,
      orphanRecoveryMod,
    ] = await Promise.all([
      import('./domains/ball-custody/RedisActionSuccessorLeaseStore.js'),
      import('./domains/ball-custody/ActionSubjectTruthResolver.js'),
      import('./domains/ball-custody/ActionSuccessorAdmissionService.js'),
      import('./domains/ball-custody/ActionSuccessorCompletionService.js'),
      import('./domains/ball-custody/ActionSuccessorProjectionRetirementService.js'),
      import('./domains/ball-custody/TaskActionSuccessorLifecycle.js'),
      import('./domains/ball-custody/ProposalStoreDelegateProvider.js'),
      import('./domains/ball-custody/RedisActionSuccessorOrphanCarrierAtomicStore.js'),
      import('./domains/ball-custody/TaskActionSuccessorOrphanRecovery.js'),
    ]);
    actionSuccessorLeaseStore = new actionStoreMod.RedisActionSuccessorLeaseStore(redis);
    taskApprovedDelegateProvider = proposalDelegateMod.createTaskApprovedDelegateProvider(proposalStore, threadStore);
    actionSubjectTruthResolver = new actionTruthMod.ActionSubjectTruthResolver(
      actionSuccessorLeaseStore,
      {
        async get(taskId: string) {
          const task = await taskStore.get(taskId);
          if (!task) return null;
          return { ...task, developmentScope: task.entrustedWork?.developmentScope };
        },
      },
      taskApprovedDelegateProvider,
    );
    actionSuccessorAdmissionService = new actionAdmissionMod.ActionSuccessorAdmissionService(
      actionSuccessorLeaseStore,
      actionSubjectTruthResolver,
    );
    const projectionRetirement = new actionProjectionRetirementMod.ActionSuccessorProjectionRetirementService({
      invocationQueue,
      taskStore: {
        getBySubject: (subjectKey) => taskStore.getBySubject(subjectKey),
        replaceAutomationStateIfGeneration: (taskId, input) =>
          taskStore.replaceAutomationStateIfGeneration(taskId, input),
      },
      publishQueue: ({ threadId, userId }) =>
        emitQueueUpdated(
          socketManager!,
          userId,
          threadId,
          invocationQueue.list(threadId, userId),
          'action_successor_terminal',
        ),
    });
    const completionService = new actionCompletionMod.ActionSuccessorCompletionService(
      actionSuccessorLeaseStore,
      actionSubjectTruthResolver,
      projectionRetirement,
    );
    actionSuccessorCompletionService = completionService;
    taskActionSuccessorLifecycle = new taskActionLifecycleMod.TaskActionSuccessorLifecycle({
      leaseStore: actionSuccessorLeaseStore,
      completionService: actionSuccessorCompletionService,
    });
    taskActionSuccessorOrphanRecovery = new orphanRecoveryMod.TaskActionSuccessorOrphanRecovery({
      tasks: taskStore,
      messages: messageStore,
      queue: invocationQueue,
      invocationRecords: invocationRecordStore,
      turnExecutions: turnExecutionStore,
      delegates: taskApprovedDelegateProvider,
      atomicStore: new orphanAtomicStoreMod.RedisActionSuccessorOrphanCarrierAtomicStore(redis),
    });
    const [dispatchApprovalMod, redisDispatchApprovalMod] = await Promise.all([
      import('./domains/approval-hub/DispatchActionApprovalService.js'),
      import('./domains/approval-hub/stores/redis/RedisDispatchActionApproval.js'),
    ]);
    dispatchActionApprovalService = new dispatchApprovalMod.DispatchActionApprovalService({
      store: dispatchProposalStore,
      admissionService: actionSuccessorAdmissionService,
      leaseStore: actionSuccessorLeaseStore,
      claimAndApprove: (proposal, userId, ownerAuthProvenance, input) =>
        redisDispatchApprovalMod.approveRedisDispatchProposalWithActionClaim(
          redis,
          proposal,
          userId,
          ownerAuthProvenance,
          input,
        ),
    });
    app.log.info('[api] F167 Phase S: action successor single-flight initialized');

    // F233 Phase B (B2): ball-custody 事件流 stack（旁路写球权事件，照 community ingest 先例）
    const [bcMod, bcStoreMod, bcProjMod, bcIngestMod] = await Promise.all([
      import('./domains/ball-custody/BallCustodyEventLog.js'),
      import('./domains/ball-custody/BallCustodyProjectionStore.js'),
      import('./domains/ball-custody/BallCustodyProjector.js'),
      import('./domains/ball-custody/BallCustodyIngest.js'),
    ]);
    ballCustodyEventLog = new bcMod.RedisBallCustodyEventLog(redis);
    ballCustodyProjectionStore = new bcStoreMod.RedisBallCustodyProjectionStore(redis);
    ballCustodyProjector = new bcProjMod.BallCustodyProjector(ballCustodyEventLog, ballCustodyProjectionStore);
    ballCustodyIngest = new bcIngestMod.BallCustodyIngest(ballCustodyEventLog, ballCustodyProjector);
    app.log.info('[api] F233 Phase B: ball-custody ingest initialized');
  }

  if (ballCustodyIngest) {
    const { withBallCustodyTaskEvents } = await import('./domains/ball-custody/BallCustodyTaskStore.js');
    taskStore = withBallCustodyTaskEvents(
      taskStore,
      ballCustodyIngest,
      { warn: app.log.warn.bind(app.log) },
      taskActionSuccessorLifecycle,
    );
  }

  // F153 Phase F AC-F4: Hydrate trace store from Redis messages on cold start
  if (telemetryHandle.traceStore && redis) {
    const { hydrateTraceStoreFromRedis } = await import('./infrastructure/telemetry/hydrate-traces.js');
    void hydrateTraceStoreFromRedis(telemetryHandle.traceStore, redis).catch(() => {});
  }

  const backlogStore = createBacklogStore(redis);
  const workflowSopStore = createWorkflowSopStore(redis);
  const summaryStore = createSummaryStore(redis);
  const memoryStore = createMemoryStore(redis);
  const taskProgressStore = createTaskProgressStore(redis);
  const draftStore = createDraftStore(redis);
  const readStateStore = createReadStateStore(redis);
  const { ExecutionDigestStore } = await import('./domains/projects/execution-digest-store.js');
  const executionDigestStore = new ExecutionDigestStore();

  if (
    redis &&
    messageStore instanceof RedisMessageStore &&
    invocationRecordStore instanceof RedisInvocationRecordStore
  ) {
    const { getOwnerUserId } = await import('./config/cat-config-loader.js');
    const backfillResult = await runSchedulerReplyUserIdBackfill({
      redis,
      messageStore,
      invocationRecordStore,
      threadStore,
      defaultUserId: getOwnerUserId(),
    });
    if (!backfillResult.skipped && (backfillResult.repairedMessages > 0 || backfillResult.repairedInvocations > 0)) {
      app.log.info(
        {
          repairedMessages: backfillResult.repairedMessages,
          repairedInvocations: backfillResult.repairedInvocations,
        },
        '[api] F139 scheduler reply userId backfill completed',
      );
    }
  }

  const sessionChainStore = createSessionChainStore(redis);
  let contextEpochStore: RedisContextEpochStore | InMemoryContextEpochStore;
  let presentationLedger: PresentationLedger;
  if (redis) {
    contextEpochStore = new RedisContextEpochStore(redis);
    presentationLedger = new PresentationLedger(new RedisPresentationLedgerStore(redis));
  } else {
    const memoryEpochStore = new InMemoryContextEpochStore();
    contextEpochStore = memoryEpochStore;
    presentationLedger = new PresentationLedger(new InMemoryPresentationLedgerStore(memoryEpochStore));
  }
  const contextEpochOwner = new ContextEpochOwner(contextEpochStore);
  const runtimeSessionStore = createRuntimeSessionStore(redis);
  // F24: Transcript Writer/Reader for session chain
  // E7 fix: resolve relative to monorepo root, not CWD (same fix as docsRoot in PR #524)
  const transcriptDataDir = process.env.TRANSCRIPT_DATA_DIR ?? `${findMonorepoRoot(process.cwd())}/data/transcripts`;
  const transcriptWriter = new TranscriptWriter({ dataDir: transcriptDataDir });
  const transcriptReader = new TranscriptReader({ dataDir: transcriptDataDir });
  // F065 Phase C: HandoffConfig for LLM-generated digest on seal
  const handoffConfig: HandoffConfig = {
    getBootstrapDepth: (catId: string) => getConfigSessionStrategy(catId)?.handoff?.bootstrapDepth ?? 'extractive',
    resolveProfile: async (threadId: string, catId: string) => {
      try {
        let projectRoot = findMonorepoRoot(process.cwd());
        const thread = await threadStore.get(threadId);
        if (thread?.projectPath && thread.projectPath !== 'default') {
          projectRoot = thread.projectPath;
        }
        const catConfig = catRegistry.tryGet(catId)?.config;
        if (catConfig?.clientId === 'anthropic' || catConfig?.clientId === 'opencode') {
          const effectiveAccountRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
          // Digests always use Anthropic, including for an OpenCode-bound gateway.
          const runtime = resolveAnthropicRuntimeProfile(projectRoot, effectiveAccountRef);
          if (!runtime?.apiKey) return null;
          return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl || 'https://api.anthropic.com' };
        }

        const runtime = resolveAnthropicRuntimeProfile(projectRoot);
        if (!runtime.apiKey) return null;
        return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl || 'https://api.anthropic.com' };
      } catch {
        return null;
      }
    },
  };
  const sessionSealer = new SessionSealer(
    sessionChainStore,
    transcriptWriter,
    threadStore,
    transcriptReader,
    handoffConfig,
    summaryStore,
  );

  // F231 AC-C3 / KD-10: Wire profile distillation trigger into session seal lifecycle.
  // The trigger fires on session-seal events (runtime-neutral, not provider Stop hooks).
  {
    const { ProfileDistillationTrigger } = await import(
      './domains/cats/services/profile/profile-distillation-trigger.js'
    );
    const distillationTrigger = new ProfileDistillationTrigger();
    sessionSealer.registerPostSealHook(async (event) => {
      await distillationTrigger.onSessionSealed(event);
    });
  }

  // F102: Memory services — SQLite-only
  const { resolve } = await import('node:path');
  const { repoRoot, docsRoot, markersDir } = resolveMemoryRepoPaths(process.cwd());

  const { initRepoIdentity, isSameRepo } = await import('./utils/is-same-repo.js');
  initRepoIdentity(repoRoot);

  const { createMemoryServices } = await import('./domains/memory/factory.js');
  const { createSqliteReadDiagnostics } = await import('./infrastructure/sqlite-read-diagnostics.js');
  const readDiagnostics = createSqliteReadDiagnostics({
    onSlowRead: (event) => app.log.warn({ module: 'sqlite-read', ...event }, 'Slow synchronous SQLite .all read'),
  });
  // Resolve embed mode. Priority:
  //   1. If the user enabled the Embedding service in console (service.enabled=true),
  //      force the in-process mode to 'on' (or honor an explicit 'shadow' / 'on' env
  //      override). UI toggle is the most direct expression of user intent — letting
  //      a stale EMBED_MODE=off in .env silently disable catch-up would be a foot-gun
  //      (sidecar runs, but evidence_vectors stays empty + catch-up logs probed=false).
  //   2. Otherwise, an explicit EMBED_MODE env wins.
  //   3. Otherwise, default 'off' (service disabled in console, no env → no
  //      embedding services wired up).
  const { getServiceConfig: getEmbedSvcCfg } = await import('./domains/services/service-config.js');
  const embedSvcEnabled = getEmbedSvcCfg('embedding-model')?.enabled ?? false;
  const resolvedEmbedMode: 'off' | 'shadow' | 'on' = (() => {
    const envMode = process.env.EMBED_MODE;
    if (embedSvcEnabled) {
      return envMode === 'shadow' || envMode === 'on' ? envMode : 'on';
    }
    if (envMode === 'off' || envMode === 'shadow' || envMode === 'on') return envMode;
    return 'off';
  })();
  app.log.info(
    `[api] F102: embed mode = ${resolvedEmbedMode} (EMBED_MODE=${process.env.EMBED_MODE ?? '(unset)'}, service.enabled=${embedSvcEnabled})`,
  );
  const memoryServices = await createMemoryServices({
    type: 'sqlite',
    readDiagnostics,
    sqlitePath: process.env.EVIDENCE_DB ?? resolve(repoRoot, 'evidence.sqlite'),
    docsRoot,
    markersDir,
    dataDir: process.env.CAT_CAFE_DATA_DIR,
    transcriptDataDir, // reuse the same resolved path as Writer/Reader (line 282)
    embed: { embedMode: resolvedEmbedMode },
    privateUserId,
    // Phase E-2: message passage indexing — provide a callback that reads thread messages
    messageListFn: (threadId: string, limit?: number) =>
      messageStore.getThreadEvidenceProjection(threadId, limit ?? 2000, privateUserId),
    // Phase E-1: thread summary indexing — provide a callback that lists all threads
    threadListFn: async () => {
      const threads = await threadStore.list('default-user');
      return threads
        .filter((t) => !t.projectPath.startsWith('games/'))
        .map((t) => ({
          id: t.id,
          title: t.title,
          participants: t.participants as string[],
          threadMemory: t.threadMemory ? { summary: t.threadMemory.summary } : null,
          lastActiveAt: t.lastActiveAt,
          featureIds: t.backlogItemId ? [t.backlogItemId] : undefined,
        }));
    },
    excludeThreadIdsFn: async () => {
      const allThreads = await threadStore.list('default-user');
      const excluded = new Set<string>();
      for (const t of allThreads) {
        if (t.projectPath.startsWith('games/')) excluded.add(t.id);
      }
      return excluded;
    },
  });
  const { MessageSearchService } = await import('./domains/memory/MessageSearchService.js');
  const { MessageSearchAnswerPublicationStore } = await import(
    './domains/memory/MessageSearchAnswerPublicationStore.js'
  );
  const { MessageSearchAnswerPublicationService } = await import(
    './domains/memory/MessageSearchAnswerPublicationService.js'
  );
  const messageSearchService = new MessageSearchService({
    evidenceStore: memoryServices.evidenceStore,
    threadStore,
    messageStore,
  });
  const messageSearchAnswerService = new MessageSearchAnswerPublicationService(
    new MessageSearchAnswerPublicationStore(memoryServices.store.getDb(), (work) =>
      memoryServices.store.runExclusive(work),
    ),
    messageSearchService,
    messageStore,
    threadStore,
  );
  app.log.info(
    { messageSearchAnswerRecovery: await messageSearchAnswerService.recoverPreparedResponses() },
    'Existing search answer bindings reconciled',
  );
  const { registerMessageSearchAnswerRoute } = await import('./routes/message-search-answer-route.js');
  registerMessageSearchAnswerRoute(app, messageSearchAnswerService);
  const profileMemoryLifecycleStore = new ProfileMemoryLifecycleStore({
    db: memoryServices.store.getDb(),
    repository: profileRepository,
  });
  const profileMemorySourceReaders = { threadStore, messageStore };
  const profileMemoryLifecycleService = new ProfileMemoryLifecycleService({
    store: profileMemoryLifecycleStore,
    coordinator: ownerMemoryActionCoordinator,
    targetLock: profileUpdateLock,
    invalidateDerived: async ({ ownerUserId }) => {
      clearL0CacheOwner(ownerUserId);
      if (!memoryServices.collectionStores || !memoryServices.catalog || !memoryServices.dataDir) return;
      const refresh = await refreshCanonicalProfileIndex(memoryServices.collectionStores, memoryServices.catalog, {
        dataDir: memoryServices.dataDir,
        userId: ownerUserId,
      });
      if (refresh.status === 'error') throw new Error(`Profile index invalidation failed: ${refresh.error}`);
    },
  });
  const eventMemorySourceReaders = { threadStore, messageStore };
  const eventMemoryLifecycleService = new EventMemoryLifecycleService({
    store: memoryServices.eventMemoryStore,
    coordinator: ownerMemoryActionCoordinator,
    sourceAvailable: async (event) =>
      (await readEventMemorySource(event, event.ownerUserId, eventMemorySourceReaders)).status === 'ready',
  });
  const entityMemoryLifecycleStore = new EntityMemoryLifecycleStore(memoryServices.store.getDb());
  const entityMemorySourceReaders = { threadStore, messageStore };
  const entityMemoryLifecycleService = new EntityMemoryLifecycleService({
    store: entityMemoryLifecycleStore,
    coordinator: ownerMemoryActionCoordinator,
    sourceAvailable: async (entity) =>
      (await readEntityMemorySource(entity, privateUserId, entityMemorySourceReaders)).status === 'ready',
  });
  const tasteMemoryLifecycleStore = new TasteMemoryLifecycleStore(memoryServices.store.getDb());
  const tasteMemoryLifecycleService = new TasteMemoryLifecycleService({
    store: tasteMemoryLifecycleStore,
    writer: new TasteMemoryProjectionWriter(tasteRepository),
    coordinator: ownerMemoryActionCoordinator,
    targetLock: tasteApprovalCoordinator.lock,
    lockKey: tasteApprovalCoordinator.lockKey,
    invalidateDerived: async ({ sourcePath }) => {
      const anchor = tasteDocumentAnchor(sourcePath);
      await memoryServices.evidenceStore.deleteByAnchor(anchor);
      memoryServices.embeddingLifecycle.getVectorStore()?.delete(anchor);
    },
  });
  const tasteProposalWriter = createTasteProposalWriter(
    createVignetteWriter(tasteRepository),
    tasteMemoryLifecycleService,
  );
  const takeawayImport = await importTasteTakeawayCandidates({
    repository: tasteRepository,
    lifecycleStore: tasteMemoryLifecycleStore,
    ownerUserId: privateUserId,
  });
  app.log.info(
    {
      imported: takeawayImport.imported,
      stale: takeawayImport.stale,
      unavailableInputs: takeawayImport.unavailableInputs,
    },
    '[F321] Taste takeaway candidates reconciled',
  );
  const { MemoryCueEpisodeStore } = await import('./domains/memory/cue/MemoryCueEpisodeStore.js');
  const { createProcessMemoryCueDrillSecret, MemoryCueDrillHandleService } = await import(
    './domains/memory/cue/MemoryCueDrillHandleService.js'
  );
  const memoryCueEpisodeStore = new MemoryCueEpisodeStore(memoryServices.store.getDb());
  const memoryCueHandles = new MemoryCueDrillHandleService(createProcessMemoryCueDrillSecret(), memoryCueEpisodeStore);
  const memoryCueDeps: CallbackMemoryCueDeps = {
    episodeStore: memoryCueEpisodeStore,
    handles: memoryCueHandles,
    now: Date.now,
    // Phase D replaces this fail-closed adapter with the three canonical lane readers.
    sourceReader: {
      async read() {
        return { status: 'not_available' as const };
      },
    },
  };
  // F152: Wire evidence store into /ready probe
  evidenceStoreRef = memoryServices.evidenceStore;
  app.log.info('[api] F102: SQLite memory services initialized');
  startupMilestone('memory-services-ready');

  // Thread index repair: rebuild ZSet indexes from thread detail hashes if sparse.
  // Prevents "all threads disappeared" after unclean shutdown.
  // Must run BEFORE evidence index rebuild — threadListFn reads ZSet indexes.
  if (threadStore.repairIndex) {
    const startMs = Date.now();
    try {
      const result = await threadStore.repairIndex();
      if (result.repairedMembers > 0) {
        app.log.info(
          `[api] Thread index repair: ${result.repairedMembers} members rebuilt across ${result.repairedUsers} user indexes (${Date.now() - startMs}ms)`,
        );
      }
    } catch (err) {
      app.log.warn(`[api] Thread index repair failed (non-fatal): ${err}`);
    }
  }

  // F152 Phase B: Expedition Bootstrap — state manager + service
  const { IndexStateManager } = await import('./domains/memory/IndexStateManager.js');
  const { ExpeditionBootstrapService } = await import('./domains/memory/ExpeditionBootstrapService.js');
  const indexStateManager = new IndexStateManager(memoryServices.store.getDb());
  const { execFileSync } = await import('node:child_process');
  const getFingerprint = (projectPath: string) => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectPath, encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  };
  const expeditionBootstrapService = new ExpeditionBootstrapService(indexStateManager, {
    rebuildIndex: async (projectPath: string) => {
      if (isSameRepo(projectPath, repoRoot)) {
        const startMs = Date.now();
        const { buildStructuralSummary } = await import('./domains/memory/ExpeditionBootstrapService.js');
        const summary = buildStructuralSummary(projectPath);
        return { docsIndexed: summary.docsList.length, durationMs: Date.now() - startMs };
      }
      const { ensureProjectCollection } = await import('./domains/memory/bootstrap-collection-bridge.js');
      return ensureProjectCollection(
        projectPath,
        memoryServices.catalog!,
        memoryServices.collectionStores ?? new Map(),
        memoryServices.dataDir!,
        () => memoryServices.embeddingLifecycle.getService(),
      );
    },
    getFingerprint,
    getTierCoverage: async (projectPath: string) => {
      if (!isSameRepo(projectPath, repoRoot)) return {};

      const db = memoryServices.store.getDb();
      const rows = db
        .prepare(
          `SELECT provenance_tier, COUNT(*) as cnt FROM evidence_docs WHERE provenance_tier IS NOT NULL AND source_path NOT LIKE 'archive/%' GROUP BY provenance_tier`,
        )
        .all() as Array<{ provenance_tier: string; cnt: number }>;
      const result: Record<string, number> = {};
      for (const row of rows) {
        result[row.provenance_tier] = row.cnt;
      }
      return result;
    },
    getKindCoverage: async (projectPath: string) => {
      if (!isSameRepo(projectPath, repoRoot)) return {};

      const { mapKindToSourceType } = await import('./routes/evidence-helpers.js');
      const db = memoryServices.store.getDb();
      const rows = db
        .prepare(
          `SELECT kind, COUNT(*) as cnt FROM evidence_docs WHERE kind IS NOT NULL AND source_path NOT LIKE 'archive/%' GROUP BY kind`,
        )
        .all() as Array<{ kind: string; cnt: number }>;
      const result: Record<string, number> = {};
      for (const row of rows) {
        const sourceType = mapKindToSourceType(row.kind);
        result[sourceType] = (result[sourceType] || 0) + row.cnt;
      }
      return result;
    },
  });

  // F102 D-2: Auto-rebuild evidence index on startup (AC-D4)
  if (memoryServices.indexBuilder) {
    const startMs = Date.now();
    try {
      const result = await memoryServices.indexBuilder.rebuild({
        deferThreadIndexing: true,
        deferDocumentEmbedding: true,
        onProgress: (phase, percent) => {
          app.log.info(
            { phase, percent, elapsedMs: Date.now() - startMs },
            '[api] F102: evidence index startup progress',
          );
        },
      });
      app.log.info(
        `[api] F102: evidence index rebuilt — ${result.docsIndexed} indexed, ${result.docsSkipped} skipped (${Date.now() - startMs}ms)`,
      );
    } catch (err) {
      app.log.warn(`[api] F102: evidence index rebuild failed (non-fatal): ${err}`);
    }
  }

  if (memoryServices.indexBuilder) {
    const { registerThreadIndexCatchUp } = await import('./domains/memory/thread-index-startup.js');
    registerThreadIndexCatchUp(app, memoryServices.indexBuilder, () =>
      memoryServices.embeddingLifecycle.catchUpAfterReady(),
    );
  }
  app.addHook('onClose', async () => memoryServices.embeddingLifecycle.deactivate());

  // F-4: Global knowledge rebuild (Skills + MEMORY.md → global_knowledge.sqlite)
  if (memoryServices.globalIndexBuilder) {
    try {
      const gResult = await memoryServices.globalIndexBuilder.rebuild();
      app.log.info(
        `[api] F102: global knowledge rebuilt — ${gResult.docsIndexed} indexed (${gResult.durationMs}ms); ` +
          `privacy audit: ${gResult.privacyAudit.personalSources} personal, ` +
          `${gResult.privacyAudit.purgedFromGlobal} purged from global, ` +
          `${gResult.privacyAudit.reLayeredPrivate} re-layered private`,
      );
    } catch (err) {
      app.log.warn(`[api] F102: global knowledge rebuild failed (non-fatal): ${err}`);
    }
  }

  // Phase E-2: Dirty-thread debounce — flush modified thread summaries every 30s
  const DIRTY_THREAD_FLUSH_INTERVAL_MS = 30_000;
  if (memoryServices.indexBuilder) {
    const { IndexBuilder } = await import('./domains/memory/IndexBuilder.js');
    const ib = memoryServices.indexBuilder;
    if (ib instanceof IndexBuilder) {
      try {
        const recallSuppressionRecovery = await ib.reconcileMessageRecallSuppressions(async (_threadId, messageId) =>
          Boolean((await messageStore.getById(messageId))?.recall),
        );
        if (recallSuppressionRecovery.retained > 0 || recallSuppressionRecovery.released > 0) {
          app.log.info(
            `[api] F264: reconciled recall index suppressions — ` +
              `${recallSuppressionRecovery.retained} retained, ${recallSuppressionRecovery.released} released`,
          );
        }
      } catch (err) {
        app.log.warn(`[api] F264: recall index suppression recovery failed (fail-closed): ${String(err)}`);
      }

      // F102 KD-34: Wire append listener now that memoryServices is ready.
      // This covers ALL 36 messageStore.append() call sites via the store itself,
      // replacing the old HTTP onResponse hooks that only caught 2 routes.
      appendListener = (msg) => {
        if (msg.threadId) {
          ib.markThreadDirty(msg.threadId);
          // G-3c P1 fix (砚砚 review): accumulate delta from actual new message,
          // not from rebuilt summary snapshot in flushDirtyThreads
          ib.accumulateSummaryDelta(msg.threadId, msg.content);
        }
      };
      // Queue publication/terminal CAS can change the scan domain without another append.
      messageStore.onTimelineChanged = (msg) => {
        ib.markThreadDirty(msg.threadId);
        ib.accumulateSummaryDelta(msg.threadId, msg.content);
      };

      const dirtyFlushTimer = setInterval(async () => {
        try {
          const flushed = await ib.flushDirtyThreads();
          if (flushed > 0) {
            app.log.info(`[api] F102 E-2: flushed ${flushed} dirty thread(s) to evidence index`);
          }
        } catch {
          // best-effort
        }
      }, DIRTY_THREAD_FLUSH_INTERVAL_MS);
      dirtyFlushTimer.unref();
      app.addHook('onClose', async () => clearInterval(dirtyFlushTimer));
    }
  }

  const priorTimelineListener = messageStore.onTimelineChanged;
  messageStore.onTimelineChanged = (message) => {
    priorTimelineListener?.(message);
    if (userMentionEvent(message) || message.mentionsUser || hasRecentWorkPublication(message))
      socketManager?.emitToUser(message.userId, 'entrusted_work_projection_invalidated', {
        ownerUserId: message.userId,
      });
  };

  // ── F139: Unified Scheduler (TaskRunnerV2) ──
  const { TaskRunnerV2 } = await import('./infrastructure/scheduler/TaskRunnerV2.js');
  const { RunLedger } = await import('./infrastructure/scheduler/RunLedger.js');
  const { createActorResolver } = await import('./infrastructure/scheduler/ActorResolver.js');
  const { getRoster } = await import('./config/cat-config-loader.js');
  const { loadDossierProfiles } = await import('@cat-cafe/shared/dossier');
  const schedulerDb = memoryServices.store.getDb();
  const runLedger = new RunLedger(schedulerDb);
  const dossierProfiles = loadDossierProfiles(resolveActiveProjectRoot());
  const actorResolver = createActorResolver(getRoster, {
    isScarce: (catId) => dossierProfiles.get(catId)?.engagementPolicy?.quota === 'weekly_subscription_scarce',
  });
  // ── F139 Phase 3B: Governance + Emission stores ──
  const { GlobalControlStore } = await import('./infrastructure/scheduler/GlobalControlStore.js');
  const { EmissionStore } = await import('./infrastructure/scheduler/EmissionStore.js');
  const { PackTemplateStore } = await import('./infrastructure/scheduler/PackTemplateStore.js');
  const globalControlStore = new GlobalControlStore(schedulerDb);
  const emissionStore = new EmissionStore(schedulerDb);
  const packTemplateStore = new PackTemplateStore(schedulerDb);

  // Phase 4: delivery + content fetch for template execution
  const { createDeliverFn, createDeliverPrivateFn, createLifecycleToastFn } = await import(
    './infrastructure/scheduler/delivery.js'
  );
  const { createFetchContentFn } = await import('./infrastructure/scheduler/content-fetcher.js');
  // RFC §5.1: one component owns atomic Message + Queue admission for every producer. `progress` is
  // late-bound: queueProcessor is constructed further down in boot, and no delivery runs before then.
  const { PersistedQueueDelivery } = await import(
    './domains/cats/services/agents/invocation/PersistedQueueDelivery.js'
  );
  const persistedQueueDelivery = new PersistedQueueDelivery({
    messages: messageStore,
    queue: invocationQueue,
    progress: (entry, targetCatId) => queueProcessor.progressOwnedCarrier(entry, targetCatId),
  });
  const schedulerDeliver = createDeliverFn({ messageStore, socketManager, persistedQueueDelivery });
  const { WorktreeNoticeService } = await import('./infrastructure/worktrees/WorktreeNoticeService.js');
  const worktreeNotices = new WorktreeNoticeService({
    repoRoot,
    scriptRoot: runtimeEntrypointRoot,
    getThread: async (id) => threadStore.get(id),
    isOwnerAvailable: (id) => catRegistry.has(id) && isCatAvailable(id),
    deliver: schedulerDeliver,
    warn: (message) => app.log.warn(message),
  });
  worktreeNotices.start();
  app.addHook('onClose', async () => worktreeNotices.stop());
  const schedulerDeliverPrivate = createDeliverPrivateFn({ persistedQueueDelivery });
  const schedulerLifecycleToast = createLifecycleToastFn({ socketManager });
  const schedulerFetchContent = createFetchContentFn();

  const taskRunnerV2 = new TaskRunnerV2({
    logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
    ledger: runLedger,
    actorResolver,
    globalControlStore,
    emissionStore,
    deliver: schedulerDeliver,
    deliverPrivate: schedulerDeliverPrivate,
    cancelQueuedDelivery: async (messageId) => {
      const source = await messageStore.getById(messageId);
      if (source?.threadId) {
        const durable = await invocationQueue.getDurableEntriesForMessages(source.threadId, [messageId]);
        if ((durable.get(messageId) ?? []).some((entry) => entry.status === 'queued' || entry.status === 'claimed')) {
          return false;
        }
      }
      const canceled = await messageStore.markCanceled(messageId);
      return canceled?.deliveryStatus === 'canceled';
    },
    notifyLifecycle: schedulerLifecycleToast,
    fetchContent: schedulerFetchContent,
    ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
  });

  // ── F32-b/F127: Bootstrap runtime catalog, then populate CatRegistry (all variants) ──
  // F255 startup reconciliation resolves every persisted cat-life projection immediately,
  // so registry population must precede auto-dream bootstrap as well as AgentRouter construction.
  try {
    const catConfig = bootstrapDefaultCatCatalog();
    const allConfigs = toAllCatConfigs(catConfig);
    for (const [id, config] of Object.entries(allConfigs)) {
      catRegistry.register(id, config);
    }
    app.log.info(`[api] CatRegistry initialized: ${catRegistry.getAllIds().join(', ')}`);
  } catch (err) {
    app.log.error(`[api] Failed to load cat catalog — .cat-cafe/cat-catalog.json is required: ${String(err)}`);
    throw err;
  }

  // F293 Phase B: one durable composition for owner API, cognition and every
  // dispatch preflight. No Redis means typed 503/degradation, never memory truth.
  const routingContextRuntime = redisClient
    ? createRoutingContextRuntime({
        redis: redisClient,
        projectRoot: resolveActiveProjectRoot(),
        getConfigs: () => catRegistry.getAllConfigs(),
      })
    : undefined;

  // F247 / F202 W2-3 h3c-2: the configured cloud cat's key is a separate credential boundary from the
  // shared local-agent map, issued in the cloud scope. Reconcile it only on the global sidecar owner;
  // never export its path into process.env; revoke the cloud keys of a cat that is no longer the cloud cat.
  const reconcileCloudCatKeys = async () => {
    const { reconcileCloudCatAgentKeys } = await import(
      './domains/cats/services/agents/agent-key/cloud-cat-agent-key-sidecar.js'
    );
    await reconcileCloudCatAgentKeys({ registry: agentKeyRegistry, cats: catRegistry, log: app.log });
  };
  if (ownsGlobalAgentKeySidecars) await reconcileCloudCatKeys();

  if (ownsGlobalAgentKeySidecars) {
    const { AgentKeySidecarRenewalLoop, reconcileSidecarsIndependently } = await import(
      './domains/cats/services/agents/agent-key/AgentKeySidecarRenewalLoop.js'
    );
    agentKeySidecarRenewalLoop = new AgentKeySidecarRenewalLoop({
      reconcile: async () => {
        const reconciliations: Array<{ name: string; reconcile: () => Promise<void> }> = [];
        reconciliations.push({ name: 'cloud-cat', reconcile: reconcileCloudCatKeys });
        await reconcileSidecarsIndependently(reconciliations);
      },
      onError: (error) => {
        app.log.warn(`[api] agent-key sidecar renewal failed; next daily tick will retry: ${String(error)}`);
      },
    });
    agentKeySidecarRenewalLoop.start();
  }

  // ── F139 Phase 3A: Dynamic task store + template registry ──
  const { DynamicTaskStore } = await import('./infrastructure/scheduler/DynamicTaskStore.js');
  const { templateRegistry } = await import('./infrastructure/scheduler/templates/registry.js');
  const dynamicTaskStore = new DynamicTaskStore(schedulerDb);
  const { ScheduleMutationProposalStore } = await import('./infrastructure/scheduler/ScheduleMutationProposalStore.js');
  const scheduleMutationProposalStore = new ScheduleMutationProposalStore(schedulerDb);
  const approvalIngress = new ApprovalIngress({ messageStore, socketManager });
  const personMemoryStore = redisClient ? new RedisPersonMemoryStore(redisClient) : null;
  const deferredPersonMemoryReceiptStore = redisClient
    ? new RedisDeferredPersonMemoryReceiptStore(redisClient)
    : undefined;
  // F276 Wave 2 bridge. Both are Redis-only: without a client the opportunity path degrades to
  // in-invocation behavior rather than silently claiming nothing is terminal.
  const writeOpportunityTerminalLedger = redisClient ? new RedisWriteOpportunityTerminalLedger(redisClient) : undefined;
  const writeOpportunityDeliveryStore = redisClient ? new RedisWriteOpportunityDeliveryStore(redisClient) : undefined;
  const personMemoryDispositionProofResolver = redisClient
    ? new PersonMemoryDispositionProofResolver(redisClient)
    : null;
  const waitTerminationStore = redisClient ? new RedisWaitTerminationStore(redisClient) : null;
  const humanDispositionLedger =
    redisClient && personMemoryDispositionProofResolver
      ? new HumanDispositionLedger(redisClient, {
          async loadEntry(input) {
            if (input.receipt.interactionKind === 'session_handoff') {
              return handoffProposalStore.loadHumanDispositionEntry(input);
            }
            if (input.receipt.interactionKind === 'person_memory_proposal') {
              return personMemoryDispositionProofResolver.loadEntry(input);
            }
            if (input.receipt.interactionKind === 'wait_cancel') {
              return waitTerminationStore?.loadEntry(input) ?? null;
            }
            return null;
          },
        })
      : null;
  const waitTerminationService = waitTerminationStore
    ? new WaitTerminationService({
        store: waitTerminationStore,
        dynamicTaskStore,
        taskRunner: taskRunnerV2,
        threadStore,
        managedWakeCancellation: {
          reserve: reserveManagedWakeCancellation,
          commit: commitManagedWakeCancellation,
          release: releaseManagedWakeCancellation,
          cancelIfTaskMatches: cancelManagedWakeIfTaskMatches,
        },
      })
    : null;
  const workspacePersonResolver = new EvidenceStoreWorkspacePersonResolver(memoryServices.evidenceStore);
  taskRunnerV2.setDynamicTaskStore(dynamicTaskStore); // #415: wire store for once-trigger auto-retirement

  if (!memoryServices.catalog || !memoryServices.collectionStores || !memoryServices.dataDir) {
    throw new Error('[api] F255 requires memory catalog, collection stores, and data directory');
  }
  const { bootstrapAutoDream, resolvePresentLoopLeaseMs } = await import(
    './domains/auto-dream/bootstrap-auto-dream.js'
  );
  const autoDream = await bootstrapAutoDream({
    app,
    ownerUserId: privateUserId,
    dataDir: memoryServices.dataDir,
    catalog: memoryServices.catalog,
    collectionStores: memoryServices.collectionStores,
    registry,
    agentKeyRegistry,
    templateRegistry,
    dynamicTaskStore,
    taskRunner: taskRunnerV2,
    threadStore,
    messageStore,
    proactiveBroadcaster: {
      publish(message) {
        if (!socketManager) throw new Error('[api] F272 requires the WebSocket manager before auto-dream bootstrap');
        socketManager.broadcastAgentMessage(
          {
            type: 'text',
            catId: message.catId as CatId,
            content: message.content,
            origin: 'callback',
            messageId: message.messageId,
            invocationId: message.messageId,
            extra: {
              isExplicitPost: true,
              proactive: { visitId: message.visitId, intentId: message.intentId, source: 'private_time' },
            },
            timestamp: message.timestamp,
          },
          message.threadId,
        );
      },
    },
    awakenedLeaseMs: resolvePresentLoopLeaseMs(process.env.CAT_CAFE_F255_AWAKENED_LEASE_MS),
  });
  memoryCueDeps.applicationEvidence = {
    hasOwnedSeedIntent: ({ ownerUserId, catId, invocationId, seedId }) =>
      autoDream.services.store.hasOwnedSeedIntentApplication(ownerUserId, catId, invocationId, seedId),
  };
  app.log.info(
    `[api] F255 Present loop ready (startup projected=${autoDream.services.startupReconciliation.projected}, removed=${autoDream.services.startupReconciliation.removed}, failed=${autoDream.services.startupReconciliation.failed}; proactive messages=${autoDream.startupProactiveReconciliation.reconciled}, proactive failures=${autoDream.startupProactiveReconciliation.failed}; life configs=${autoDream.startupLifeReconciliation.reconciled}, orphan tasks disabled=${autoDream.startupLifeReconciliation.disabledOrphans}, life failures=${autoDream.startupLifeReconciliation.failed})`,
  );

  // F271 Phase A: reflect sealed transcript deltas into the pull-only public
  // candidate lane and deliver private desire cues through F255's canonical
  // owner-scoped sink. Register only after F255 bootstrap makes the sink ready.
  {
    const [
      { MemoryReflectionStore },
      { SessionReflectionProducer },
      { DailyContextReflectionProducer },
      { createDailyContextReflectionTaskSpec },
    ] = await Promise.all([
      import('./domains/memory/MemoryReflectionStore.js'),
      import('./domains/memory/SessionReflectionProducer.js'),
      import('./domains/memory/DailyContextReflectionProducer.js'),
      import('./domains/memory/DailyContextReflectionTaskSpec.js'),
    ]);
    const reflectionStore = new MemoryReflectionStore(memoryServices.store);
    const getHouseholdTimeZone = () => getCoCreatorConfig().timeZone;
    const reflectionProducer = new SessionReflectionProducer({
      transcriptReader,
      reflectionStore,
      cueSink: autoDream.services.store,
      getHouseholdTimeZone,
    });
    sessionSealer.registerPostSealHook(async (event) => {
      await reflectionProducer.onSessionSealed(event);
    });
    const dailyReflectionProducer = new DailyContextReflectionProducer({
      ownerUserId: privateUserId,
      threadStore,
      sessionChainStore,
      reflectionProducer,
      getHouseholdTimeZone,
    });
    taskRunnerV2.register(
      createDailyContextReflectionTaskSpec({
        producer: dailyReflectionProducer,
        householdTimeZone: getHouseholdTimeZone(),
        log: app.log,
      }),
    );
    app.log.info('[api] F271 Phase B: daily context reflection registered');
  }

  // ── F139 Phase 2+3A+3B: Schedule panel API routes ──
  const { scheduleRoutes } = await import('./routes/schedule.js');
  await app.register(scheduleRoutes, {
    taskRunner: taskRunnerV2,
    dynamicTaskStore,
    templateRegistry,
    globalControlStore,
    packTemplateStore,
    taskStore,
    threadStore,
    notifyLifecycle: schedulerLifecycleToast,
    registry,
    agentKeyRegistry,
    ownerUserId: privateUserId,
    scheduleMutationProposalStore,
    approvalIngress,
  });
  const { scheduleProposalDecisionRoutes } = await import('./routes/schedule-proposal-decision-routes.js');
  await app.register(scheduleProposalDecisionRoutes, {
    ownerUserId: privateUserId,
    store: scheduleMutationProposalStore,
    taskRunner: taskRunnerV2,
    templateRegistry,
    socketManager,
    notifyLifecycle: schedulerLifecycleToast,
  });

  // ── F149 Phase C: ACP process pool registry (variantId → AcpProcessPool) ──
  const acpPoolRegistry: AcpPoolRegistry = new Map();
  const sessionContractSettings = readSessionContractSettings(process.env);
  for (const warning of sessionContractSettings.warnings) app.log.warn(warning);
  const sessionImplementations = new SessionImplementationRegistry();
  const registeredSessionServices = new Map<string, RegisteredSessionAgentService>();
  // F254: Codex app-server warm hosts are profile-scoped and survive catalog refreshes.
  const codexAppServerPoolRegistry: CodexAppServerPoolRegistry = new Map();
  const nativeRealtimeCompanionEnabled = isNativeRealtimeCompanionDeployment(process.env.CAT_CAFE_DEPLOYMENT_ID);

  // ── F32-b: AgentRegistry (catId → AgentService) — one instance per cat ──
  // Each cat gets its own AgentService instance with its catId + model.
  const agentRegistry = new AgentRegistry();
  let sessionConfigurationRevision = 0;
  const syncAgentRegistry = async (configs: Record<string, CatConfig>, warmPrompts = true) =>
    agentRegistry.refresh(async () => {
      sessionConfigurationRevision++;
      clearL0Cache(); // Invalidate stale L0 compilations from previous sync
      const projectRoot = resolveActiveProjectRoot();
      const activeAcpProfileIds = new Set<string>();
      const activeRegisteredSessionIds = new Set<string>();
      const activeCodexProfileIds = new Set<string>();
      for (const [id, config] of Object.entries(configs)) {
        await saveSpan(
          'registry.member',
          async () => {
            const catId = config.id;
            // F32-b P1 fix: do NOT pass model here — let constructors resolve via
            // getCatModel(catId) which respects env override (CAT_*_MODEL > config > fallback)
            const service = await selectSessionAgentService<
              AgentService | undefined | Promise<AgentService | undefined>
            >(
              resolveMemberSessionRef(
                config.agentProvider,
                sessionContractSettings.bindings.get(id),
                config.carrier === 'acp' ? getAcpConfig(id, projectRoot)?.agentProvider : undefined,
              ),
              async (sessionRef) => {
                activeAcpProfileIds.add(id);
                activeRegisteredSessionIds.add(id);
                const previous = registeredSessionServices.get(id);
                if (previous && previous.implementationKey !== sessionImplementationKey(sessionRef)) {
                  await previous.releaseAll('member_binding_changed');
                  registeredSessionServices.delete(id);
                }
                const registered =
                  registeredSessionServices.get(id) ??
                  new RegisteredSessionAgentService({
                    catId,
                    ref: sessionRef,
                    registry: sessionImplementations,
                    metadata: { provider: config.provider ?? 'acp', model: getCatModel(id) },
                    log: app.log,
                  });
                registeredSessionServices.set(id, registered);
                try {
                  await registered.prepare();
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  agentRegistry.markUnavailable(id, { code: 'ACP_BOOTSTRAP_UNAVAILABLE', message });
                  app.log.warn({ catId: id, err: error }, 'Plugin ACP member preparation failed');
                  return;
                }
                return registered;
              },
              async () => {
                let service: AgentService;
                // ── F161: Generic ACP transport path (provider-agnostic) ──
                // Carrier selection is resolved once by cat-config-loader. The ACP block
                // below contains only launch details; its mere presence is not routing truth.
                const acpConfig = config.carrier === 'acp' ? getAcpConfig(id, projectRoot) : undefined;
                if (config.carrier === 'acp') {
                  if (!acpConfig) {
                    app.log.warn(
                      `[api] Cat "${id}" selects carrier=acp but has no ACP config. It will not be routable.`,
                    );
                    return;
                  }
                  activeAcpProfileIds.add(id);
                  let acpService: Awaited<ReturnType<typeof createAcpServiceForConfig>>;
                  try {
                    acpService = await createAcpServiceForConfig({
                      projectRoot,
                      profileId: id,
                      config,
                      effectiveModel: getCatModel(id),
                      acpConfig,
                      poolRegistry: acpPoolRegistry,
                      log: app.log,
                      onUnavailable: (reason) => agentRegistry.markUnavailable(id, reason),
                    });
                  } catch (error) {
                    // A single member's bootstrap/privacy failure must not keep the API
                    // from listening; degrade that member and keep every other cat.
                    const reason = error instanceof Error ? error.message : String(error);
                    app.log.warn(`[api] Cat "${id}" ACP startup failed; marking it unavailable: ${reason}`);
                    agentRegistry.markUnavailable(id, { code: 'ACP_BOOTSTRAP_UNAVAILABLE', message: reason });
                    return;
                  }
                  if (!acpService) return;
                  service = acpService;
                } else
                  switch (config.clientId) {
                    // ── Provider-specific CLI paths (non-ACP) ──
                    case 'anthropic': {
                      if (config.carrier === 'sdk') {
                        service = new ClaudeSdkAgentService({ catId });
                      } else {
                        const { createClaudeAgentServiceForCanary } = await import(
                          './domains/cats/services/agents/providers/claude-carrier-factory.js'
                        );
                        service = createClaudeAgentServiceForCanary(catId);
                      }
                      break;
                    }
                    case 'openai': {
                      activeCodexProfileIds.add(id);
                      const appServerHostPool = getOrCreateCodexAppServerPool(codexAppServerPoolRegistry, id);
                      service = new CodexAgentService({
                        catId,
                        appServerHostPool,
                        carrierMode: config.carrier === 'app_server' ? 'app_server' : 'exec_json',
                        nativeRealtimeCompanionEnabled,
                      });
                      break;
                    }
                    case 'google':
                      try {
                        service = createGoogleAgentService(catId, config.agyProfile);
                      } catch (error) {
                        if (!(error instanceof AgentServiceUnavailableError)) throw error;
                        agentRegistry.markUnavailable(id, error.reason);
                        return;
                      }
                      break;
                    case 'kimi':
                      service = new KimiAgentService({ catId });
                      break;
                    case 'antigravity':
                      agentRegistry.markUnavailable(id, {
                        code: 'AGY_IDE_EXECUTION_RETIRED',
                        message:
                          'AGY IDE 执行入口已退役。请在成员设置选择 Google 的 AGY Native 入口；成员身份与历史保留。',
                      });
                      return;
                    case 'opencode':
                      service = new OpenCodeAgentService({ catId });
                      break;
                    case 'catagent': {
                      const { CatAgentService } = await import(
                        './domains/cats/services/agents/providers/catagent/CatAgentService.js'
                      );
                      service = new CatAgentService({ catId, projectRoot: findMonorepoRoot(), catConfig: config });
                      break;
                    }
                    case 'a2a': {
                      const { A2AAgentService } = await import(
                        './domains/cats/services/agents/providers/A2AAgentService.js'
                      );
                      const envKey = `CAT_${id.toUpperCase()}_A2A_URL`;
                      const a2aUrl = process.env[envKey] ?? '';
                      if (!a2aUrl) {
                        app.log.warn(`[api] A2A cat "${id}" missing ${envKey} env var. It will not be routable.`);
                        return;
                      }
                      service = new A2AAgentService({ catId, config: { url: a2aUrl } });
                      break;
                    }
                    default:
                      app.log.warn(
                        `[api] Unknown client "${config.clientId}" for cat "${id}". It will not be routable.`,
                      );
                      return;
                  }
                return service;
              },
            );
            if (service) agentRegistry.register(id, service);
          },
          { catId: id },
        );
      }
      for (const [id, registered] of registeredSessionServices) {
        if (activeRegisteredSessionIds.has(id)) continue;
        await registered.releaseAll('member_removed');
        registeredSessionServices.delete(id);
      }
      await closeStaleAcpPools(acpPoolRegistry, activeAcpProfileIds, {
        reason: 'config-sync',
        onCloseError: (err, profileId, reason) => {
          app.log.warn({ err, profileId, reason }, 'ACP registry sync failed to close stale member pool');
        },
      });
      await closeStaleCodexAppServerPools(codexAppServerPoolRegistry, activeCodexProfileIds, (err, profileId) => {
        app.log.warn({ err, profileId }, 'Codex app-server registry sync failed to close stale member pool');
      });
      if (router) saveSpan('registry.router', () => router.refreshFromRegistry(agentRegistry));

      // Pre-compile L0 system prompts for all registered cats in parallel.
      // Avoids per-invocation subprocess overhead and ensures L0 is ready
      // before the first message — also bypasses Windows NTFS junction
      // issues that resolve by the time the user actually interacts (#802).
      const registeredCatIds = Object.keys(configs).filter((id) => agentRegistry.has(id));
      if (warmPrompts) await warmL0Cache(registeredCatIds, app.log);
    });
  await syncAgentRegistry(catRegistry.getAllConfigs());

  // F321: one optional curator, using the existing native service and summary storage.
  if (memoryServices.indexBuilder) {
    try {
      const { registerLunaCuration } = await import('./luna-curation-setup.js');
      await registerLunaCuration({
        app,
        db: memoryServices.store.getDb(),
        runExclusive: (fn) => memoryServices.store.runExclusive(fn),
        projectRoot: resolveActiveProjectRoot(),
        ownerUserId: privateUserId,
        householdTimeZone: getCoCreatorConfig().timeZone ?? 'UTC',
        agentRegistry,
        taskRunner: taskRunnerV2,
        threadStore,
        messageStore,
        deliver: schedulerDeliver,
        reEmbed: async (anchor, text) => {
          const service = memoryServices.embeddingLifecycle.getService();
          const vectors = memoryServices.embeddingLifecycle.getVectorStore();
          if (!service?.isReady() || !vectors) return;
          const [vector] = await service.embed([text]);
          vectors.upsert(anchor, vector);
        },
      });
    } catch (error) {
      app.log.warn({ error }, '[memory-curation] optional initialization unavailable');
    }
  }

  const runtimeSessionSealReaper = new RuntimeSessionSealReaper({
    runtimeSessionStore,
    sessionSealer,
    drainRuntimeSession: async (record) => {
      if (!agentRegistry.has(record.catId)) {
        return {
          ok: false,
          drainResult: 'skipped_runtime_unreachable',
          reason: `no AgentService registered for ${record.catId}`,
        };
      }
      const service = agentRegistry.get(record.catId);
      if (!hasRuntimeSessionDrain(service)) {
        return {
          ok: false,
          drainResult: 'skipped_runtime_unreachable',
          reason: `AgentService for ${record.catId} cannot drain ${record.runtime}`,
        };
      }
      return service.drainRuntimeSession(record.runtimeSessionId);
    },
  });

  // F136 Phase 4c: Account binding subscriber — rebinds provider profiles when accounts change
  const { createAccountBindingSubscriber } = await import('./config/account-binding-subscriber.js');
  const accountBindingSubscriber = createAccountBindingSubscriber({
    async onRebind(changedAccountRefs) {
      app.log.info(`[api] F136: Accounts changed [${changedAccountRefs.join(', ')}], syncing agent registry...`);
      await syncAgentRegistry(catRegistry.getAllConfigs());
    },
    log: app.log,
  });

  // F089 Phase 2: Shared instances for tmux agent pane execution (opt-in)
  const enableTmuxAgent = process.env.CAT_CAFE_TMUX_AGENT === '1';
  let tmuxGateway: TmuxGateway | undefined;
  if (enableTmuxAgent) {
    try {
      tmuxGateway = new TmuxGateway();
      app.log.info(`[tmux] enabled — binary: ${tmuxGateway.tmuxBin}`);
    } catch (err) {
      app.log.error(`[tmux] CAT_CAFE_TMUX_AGENT=1 but tmux not found: ${(err as Error).message}`);
    }
  }
  // F198 Phase C P1-1: registry is unconditional — bg carrier sessions (claude --bg)
  // must be trackable regardless of whether tmux agent panes are enabled.
  const agentPaneRegistry = new AgentPaneRegistry();

  // F120: Preview Gateway (独立端口反向代理) + Port Discovery
  const PREVIEW_GATEWAY_ENABLED = process.env.PREVIEW_GATEWAY_ENABLED !== '0';
  const PREVIEW_GATEWAY_PORT = Number.parseInt(process.env.PREVIEW_GATEWAY_PORT ?? '4100', 10);
  const runtimePorts = collectRuntimePorts();
  const previewGateway = new PreviewGateway({ port: PREVIEW_GATEWAY_PORT, runtimePorts });
  const portDiscovery = new PortDiscoveryService();
  if (PREVIEW_GATEWAY_ENABLED) {
    try {
      await previewGateway.start();
      app.log.info(`[preview] Gateway started on port ${previewGateway.actualPort}`);
    } catch (err) {
      app.log.warn(`[preview] Gateway failed to start: ${(err as Error).message}`);
    }
  } else {
    app.log.info('[preview] Gateway disabled (PREVIEW_GATEWAY_ENABLED=0)');
  }
  // Port discovery → Socket.IO push to worktree-scoped room
  portDiscovery.onDiscovered((port) => {
    if (socketManager) {
      const room = port.worktreeId ? `worktree:${port.worktreeId}` : 'preview:global';
      socketManager.broadcastToRoom(room, 'preview:port-discovered', port);
    }
  });

  // F129: Pack store — shared between router (invocation) and routes (API)
  const { PackStore } = await import('./domains/packs/PackStore.js');
  const packStoreDir = join(findMonorepoRoot(process.cwd()), '.cat-cafe', 'packs');
  const packStore = new PackStore(packStoreDir);

  // F150: Tool usage counter (fire-and-forget INCR on tool_use events)
  const toolUsageArchiver = redis
    ? new (await import('./domains/cats/services/tool-usage/ToolUsageArchiver.js')).ToolUsageArchiver(
        join(findMonorepoRoot(process.cwd()), '.cat-cafe', 'tool-usage-archive.jsonl'),
      )
    : undefined;
  const toolUsageCounter = redis
    ? new (await import('./domains/cats/services/tool-usage/ToolUsageCounter.js')).ToolUsageCounter(
        redis,
        toolUsageArchiver,
      )
    : undefined;
  // F188 Phase F AC-F10: append-only tool event log (sequence preserving)
  const toolEventLog = redis
    ? new (await import('./domains/cats/services/tool-usage/ToolEventLog.js')).ToolEventLog(redis)
    : undefined;
  // F188 Phase F AC-F10 (AS-4): skill load event log
  const skillLoadEventLog = redis
    ? new (await import('./domains/cats/services/tool-usage/SkillLoadEventLog.js')).SkillLoadEventLog(redis)
    : undefined;

  // F150: Daily archive sweep — persist expiring Redis counters to JSONL
  if (toolUsageCounter && toolUsageArchiver) {
    const sweepLog = (await import('./infrastructure/logger.js')).createModuleLogger('tool-usage-sweep');
    let sweepInFlight = false;
    const runSweep = async () => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      try {
        const archivedDates = await toolUsageArchiver.getArchivedDates();
        // Catch-up: archive ALL unarchived dates older than 7 days (not just 85-89).
        // Covers downtime gaps — any date still in Redis but not yet archived gets saved.
        const now = new Date();
        const targetDates = new Set<string>();
        for (let offset = 7; offset <= 89; offset++) {
          const d = new Date(now);
          d.setDate(d.getDate() - offset);
          const dateStr = d.toISOString().slice(0, 10);
          if (!archivedDates.has(dateStr)) targetDates.add(dateStr);
        }
        if (targetDates.size === 0) return;
        // Single SCAN for all dates, then filter client-side
        const allEntries = await toolUsageCounter.fetchAllEntries();
        let archived = 0;
        for (const date of targetDates) {
          const entries = allEntries.filter((e) => e.date === date);
          if (entries.length > 0) {
            archived += await toolUsageArchiver.archiveEntries(entries);
          }
        }
        if (archived > 0) sweepLog.info({ archived }, 'Tool usage archive sweep completed');
      } catch (err) {
        sweepLog.warn({ err }, 'Tool usage archive sweep failed');
      } finally {
        sweepInFlight = false;
      }
    };
    // First sweep 30s after startup, then daily
    const startupTimer = setTimeout(runSweep, 30_000);
    startupTimer.unref();
    const dailyTimer = setInterval(runSweep, 24 * 60 * 60 * 1000);
    dailyTimer.unref();
  }

  // F093: World Engine — runtime store + coordinator + context provider
  const { SqliteWorldStore } = await import('./domains/world/SqliteWorldStore.js');
  const { WorldRuntimeCoordinator } = await import('./domains/world/WorldRuntimeCoordinator.js');
  const { WorldContextProvider } = await import('./domains/world/WorldContextProvider.js');
  const { WorldKnowledgeAdapter } = await import('./domains/world/WorldKnowledgeAdapter.js');
  const worldDbPath = process.env.WORLD_DB ?? resolve(repoRoot, 'world.sqlite');
  const worldStore = new SqliteWorldStore(worldDbPath);
  await worldStore.initialize();
  const worldCoordinator = new WorldRuntimeCoordinator(worldStore);
  const worldKnowledgeAdapter = new WorldKnowledgeAdapter(memoryServices.evidenceStore);
  const worldContextProvider = new WorldContextProvider(worldStore, worldKnowledgeAdapter);

  // F229: Concierge config store — created before AgentRouter so it can be passed into
  // invocationDeps for routing-layer 岗位 prompt injection (ConciergeRoutingInterceptor).
  const { RedisConciergeConfigStore: _RCCSEarly, MemoryConciergeConfigStore: _MCCSEarly } = await import(
    './domains/concierge/ConciergeConfigStore.js'
  );
  const conciergeConfigStoreShared = redis ? new _RCCSEarly(redis) : new _MCCSEarly();

  // F229 Phase B: TriagePlan store (needed by AgentRouter for reply validator)
  const { RedisConciergeTriagePlanStore: _RTPSEarly, MemoryConciergeTriagePlanStore: _MTPSEarly } = await import(
    './domains/concierge/ConciergeTriagePlanStore.js'
  );
  const conciergeTriagePlanStore = redis ? new _RTPSEarly(redis) : new _MTPSEarly();

  // F229 Phase B2: InvestigationJob store
  const { RedisConciergeInvestigationJobStore: _RIJSEarly, MemoryConciergeInvestigationJobStore: _MIJSEarly } =
    await import('./domains/concierge/ConciergeInvestigationJobStore.js');
  const conciergeInvestigationJobStore = redis ? new _RIJSEarly(redis) : new _MIJSEarly();

  // F247: Cloud invoke bridge — the background conversation Host adapter is the only transport
  // (the legacy PinchTab bridge was removed, issue #1538).
  const { CloudInvokeBridge } = await import('./domains/cats/services/cloud-bridge/cloud-invoke-bridge.js');
  const bridgeLogger = (await import('./infrastructure/logger.js')).createModuleLogger('cloud-bridge');
  const { CloudReturnBindingSigner, loadOrCreateCloudReturnBindingSigner } = await import(
    './domains/cats/services/cloud-bridge/cloud-return-binding.js'
  );
  const cloudReturnBindingSigner = redis
    ? await loadOrCreateCloudReturnBindingSigner(redis)
    : new CloudReturnBindingSigner();
  const { MemoryCloudReturnGrantStore, RedisCloudReturnGrantStore } = await import(
    './domains/cats/services/cloud-bridge/cloud-return-grant.js'
  );
  // Without Redis, source bindings live as long as this process: its start is the history boundary.
  const cloudReturnGrantStore = redis
    ? new RedisCloudReturnGrantStore(redis)
    : new MemoryCloudReturnGrantStore(Date.now, { historyBoundary: Date.now() });
  if (cloudReturnGrantStore instanceof RedisCloudReturnGrantStore) {
    // F202 h3c-2: sources of grants persisted before sources were bound get their owner before any
    // dispatch is admitted. A failure here is retried by the store itself, which refuses until done.
    await cloudReturnGrantStore.bindPersistedSources().catch((error: unknown) => {
      app.log.warn(`[api] binding persisted cloud return sources failed; retried on first use: ${String(error)}`);
    });
  }
  const { CloudAssistantReturnIngestService } = await import(
    './domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js'
  );
  const { createCloudConversationComposition } = await import(
    './domains/cats/services/cloud-bridge/plugin-conversation-host/cloud-conversation-composition.js'
  );
  const cloudConversations = createCloudConversationComposition({
    catalogLog: app.log,
    async reconcileCats() {
      app.log.info('[api] F136: Cat catalog changed, syncing agent registry...');
      await syncAgentRegistry(reconcileCatRegistry(resolveActiveProjectRoot(), new Set()));
    },
    cats: catRegistry,
    ingestService: new CloudAssistantReturnIngestService({
      messageStore,
      grantStore: cloudReturnGrantStore,
      socketManager: getSocketManager(),
      logger: bridgeLogger,
      cats: catRegistry,
    }),
    logger: bridgeLogger,
    grantPersistence: redis ? 'durable' : 'ephemeral',
  });
  cloudConversations.start();
  app.addHook('onClose', async () => cloudConversations.stop());
  let dotEventsBridge:
    | import('./domains/cats/services/cloud-bridge/dot/DotEventsBridge.js').DotEventsBridge
    | undefined;
  let dotReturnService:
    | import('./domains/cats/services/cloud-bridge/dot/DotReturnService.js').DotReturnService
    | undefined;
  let dotAskService: import('./domains/cats/services/cloud-bridge/dot/DotAskService.js').DotAskService | undefined;
  const cloudInvokeBridge = new CloudInvokeBridge({
    dispatchDot: async (params) =>
      dotEventsBridge?.dispatch(params) ?? { kind: 'fallback', reason: 'no-adapter', detail: 'dot 连接尚未就绪。' },
    hostAdapter: cloudConversations.adapter,
    emitFallback: async ({ threadId: fbThreadId, catId: fbCatId, reason }) => {
      // invokeSingleCat owns the one user-visible status so route persistence,
      // F167 disposition, and Queue settlement share one child invocation.
      bridgeLogger.info(
        { threadId: fbThreadId, catId: fbCatId, reason },
        'F247 bridge fallback captured; invocation will publish the terminal status',
      );
    },
    threadStore,
    logger: bridgeLogger,
  });

  let invocationQueueRef: {
    hasActiveOrQueuedAgentForCat(threadId: string, catId: string, opts?: { excludeEntryId?: string }): boolean;
    getQueuedFreshnessMessagesForCat(
      threadId: string,
      userId: string,
      catId: string,
      opts?: { excludeEntryId?: string; parentInvocationId?: string },
    ): Array<{
      entryId?: string;
      from: import('@cat-cafe/shared').MessageFrom;
      content: string;
      messageId?: string | null;
      sourceCategory?: string;
    }>;
  } | null = null;
  const freshnessStateStore = redis ? new FreshnessInvocationStateStore(redis) : undefined;

  // F254 Phase D (AC-D4): Freshness event log for stream output audit trail.
  const freshnessEventLog = redis ? new FreshnessAttentionEventLog(redis) : undefined;
  if (freshnessEventLog) {
    try {
      await freshnessEventLog.initializeWindowedReplayCoverage();
    } catch (err) {
      // Runtime correctness remains fail-open; eval publication will fail closed
      // while the trustworthy replay coverage watermark is unavailable.
      app.log.warn({ err }, '[F254] failed to initialize windowed freshness replay coverage');
    }
  }
  const freshnessOutputCommitCoordinator = new FreshnessOutputCommitCoordinator({ messageStore });

  // F237 Phase 2: InjectionTraceStore — prompt injection trace persistence
  const { InjectionTraceStore: _ITSEarly } = await import('./domains/prompt-hooks/InjectionTraceStore.js');
  const injectionTraceStore = redis ? new _ITSEarly(redis) : undefined;

  // Shared AgentRouter — used by messagesRoutes and invocationsRoutes
  const { TurnCustodyProjectionService } = await import('./domains/ball-custody/TurnCustodyProjectionService.js');
  const turnCustodyProjectionService = new TurnCustodyProjectionService({
    tasks: taskStore,
    ...(actionSuccessorLeaseStore ? { actionSuccessorLeaseStore } : {}),
  });
  const { LiveCompanionSessions } = await import('./domains/concierge/live/LiveCompanionSessions.js');
  const { createLiveConfigChange } = await import('./domains/concierge/live/live-config-transition.js');
  const { createF317MeetingSource } = await import('./domains/concierge/meeting/f317-meeting-source.js');
  const { createRealtimeCompanionAudioSource: createF317AudioWakeSource } = await import(
    './routes/realtime-companion-audio-source.js'
  );
  const { resolveAudioServiceUrl } = await import('./routes/audio-proxy.js');
  const meetingAudioUrl = resolveAudioServiceUrl();
  const meetingWake = createF317AudioWakeSource({ url: meetingAudioUrl });
  const liveCompanionSessions = new LiveCompanionSessions({
    source: createF317MeetingSource({
      transcriptDir: process.env.TRANSCRIPT_DIR ?? join(findMonorepoRoot(), 'scripts/meeting-copilot/transcripts'),
      audioServiceUrl: meetingAudioUrl,
    }),
    wakeSource: {
      subscribe: async (threadId, callbacks) => {
        const subscription = await meetingWake.subscribe(threadId, {
          onTranscript: () => callbacks.onTranscript(),
          onStopped: callbacks.onStopped,
          onError: callbacks.onError,
        });
        void subscription.closed.catch((error) => callbacks.onError?.(error));
        return { close: () => subscription.close() };
      },
    },
  });
  const proactiveCandidateRegistryResolver = personMemoryStore
    ? new ProactiveCandidateRegistryResolver({
        entityRegistry: new EntityRegistryStore(memoryServices.store.getDb()),
        entityProposalStore,
        personMemoryStore,
      })
    : undefined;
  const proactiveMemoryNudgeService = proactiveCandidateRegistryResolver
    ? new ProactiveMemoryNudgeService({
        detector: new ProactiveMemoryCandidateDetector(messageStore, threadStore),
        registryResolver: proactiveCandidateRegistryResolver,
        receiptStore: sharedProactiveCandidateNudgeReceiptStore(memoryServices.store.getDb()),
      })
    : undefined;
  const humanDispositionFeedbackContextService =
    proactiveCandidateRegistryResolver &&
    personMemoryStore &&
    personMemoryDispositionProofResolver &&
    humanDispositionLedger
      ? new HumanDispositionFeedbackContextService({
          subjectResolver: new PersonMemoryDispositionSubjectProofResolver(
            proactiveCandidateRegistryResolver,
            personMemoryStore,
            personMemoryDispositionProofResolver,
          ),
          ledger: humanDispositionLedger,
          logger: {
            warn(fields, message) {
              app.log.warn(fields, message);
            },
          },
        })
      : undefined;
  const personMemoryRecallService = personMemoryStore
    ? new PersonMemoryRecallService(personMemoryStore, workspacePersonResolver)
    : undefined;
  const { createMemoryCueRuntime } = await import('./domains/memory/cue/createMemoryCueRuntime.js');
  const { createThreadRecallSource } = await import('./domains/memory/curation/create-thread-recall-runtime.js');
  const threadOverviewSource = createThreadRecallSource({
    db: memoryServices.store.getDb(),
    projectRoot: resolveActiveProjectRoot(),
    ownerUserId: privateUserId,
    threadStore,
    messageStore,
    logger: app.log,
  });
  const memoryCueRuntime = createMemoryCueRuntime({
    ...(memoryServices.catalog && memoryServices.collectionStores && memoryServices.knowledgeResolver
      ? {
          contextProjectDiscovery: {
            threads: threadStore,
            catalog: memoryServices.catalog,
            stores: memoryServices.collectionStores,
            resolver: memoryServices.knowledgeResolver,
            homeProjectPath: resolveActiveProjectRoot(),
            homeDocsRoot: docsRoot,
          },
        }
      : {}),
    contextSourceOpportunityStore: new ContextSourceOpportunityStore(memoryServices.store.getDb()),
    contextSourceAuthorization: {
      threads: threadStore,
      tasks: taskStore,
      onOmission: (sourceMessageId, reason) =>
        app.log.info({ sourceMessageId, reason }, '[F321] context source admission omitted'),
      ...(actionSuccessorLeaseStore ? { leases: actionSuccessorLeaseStore } : {}),
      ...(taskApprovedDelegateProvider ? { delegates: taskApprovedDelegateProvider } : {}),
    },
    threadOverviewSource,
    episodeStore: memoryCueEpisodeStore,
    handles: memoryCueHandles,
    evidenceStore: memoryServices.evidenceStore,
    messageStore,
    eventStore: memoryServices.eventMemoryStore,
    entityRegistry: new EntityRegistryStore(memoryServices.store.getDb()),
    ...(personMemoryRecallService ? { personRecall: personMemoryRecallService } : {}),
    tasteRepository,
    tasteLifecycle: tasteMemoryLifecycleStore,
    ownerUserId: privateUserId,
    profileRepository,
    projectDocsRoot: docsRoot,
    autoDreamStore: autoDream.services.store,
  });
  memoryCueDeps.sourceReader = memoryCueRuntime.sourceReader;
  const threadExecutionSituationSource = createThreadExecutionSituationSource({
    messageStore,
    listActiveRuns: (threadId) =>
      invocationTracker.getActiveSlots(threadId).flatMap((slot) => (slot.activeRun ? [slot.activeRun] : [])),
  });
  // F117 K2: the Claude Agent SDK carrier runs PreCompact and SessionStart(compact) in-process. They
  // reuse the session hooks route's seal and post-compact projection; an in-process hook is
  // authenticated by construction, so it needs no callback registry.
  const inProcessCompactionSurface = createSessionCompactionSurface({
    sessionChainStore,
    transcriptReader,
    ...(contextEpochOwner ? { contextEpochOwner } : {}),
    resolveContextCapability: (catId) => router.contextCapability(catId),
    postCompactContextProjector: (input) => createPostCompactContextProjector(router.getStrategyDeps())(input),
    hookAuthenticationReady: true,
  });
  const inProcessSealOnPreCompact = createSealOnPreCompact({
    sessionChainStore,
    sessionSealer,
    compactionSurface: inProcessCompactionSurface,
  });
  const claudeCompactionHooks: ClaudeCompactionHooksFactory = ({ invocationId }) => ({
    preCompact: async ({ cliSessionId, trigger }) => {
      const outcome = await inProcessSealOnPreCompact(invocationId, cliSessionId, `claude-code-compact-${trigger}`);
      if (outcome.status !== 200) {
        app.log.warn({ invocationId, cliSessionId, outcome }, 'F117 K2: in-process PreCompact recorded no observation');
      }
    },
    postCompactContext: ({ cliSessionId }) => inProcessCompactionSurface.postCompactContextFor(cliSessionId),
  });
  let trustedImagePathResolver: (hmrId: string) => Promise<string | undefined> = async () => undefined;
  const { createOwnedWaitStatusReader } = await import('./domains/ball-custody/OwnedWaitStatus.js');
  const ownedWaitStatusReader = createOwnedWaitStatusReader({ taskStore, dynamicTaskStore });
  const { OrdinaryTaskHandoffService } = await import('./domains/ball-custody/OrdinaryTaskHandoffService.js');
  const cliExecutionOwnerService = createCliExecutionOwnerService({ log: app.log });
  const { LegacyTaskExecutionResolver } = await import('./domains/ball-custody/LegacyTaskExecution.js');
  const { taskCliProviderIsStopped } = await import('./domains/ball-custody/task-provider-stop-proof.js');
  const { taskHandoffDispatchAuthority } = await import('./routes/task-handoff-dispatch-authority.js');
  const legacyTaskExecutions = new LegacyTaskExecutionResolver({
    leases: actionSuccessorLeaseStore,
    messages: messageStore,
    turns: turnExecutionStore,
    delegates: taskApprovedDelegateProvider,
  });
  const ordinaryTaskHandoffs = new OrdinaryTaskHandoffService({
    tasks: taskStore,
    messages: messageStore,
    threads: threadStore,
    turns: turnExecutionStore,
    delegates: taskApprovedDelegateProvider,
    tracker: invocationTracker,
    dispatchAuthority: taskHandoffDispatchAuthority(dispatchProposalStore, app.log),
    legacy: legacyTaskExecutions,
    providerIsStopped: taskCliProviderIsStopped,
    stopExecution: async (ref, userId) => {
      const live = await cliExecutionOwnerService.listLive();
      if (
        !live.complete ||
        !live.owners.some(
          (owner) =>
            owner.invocationId === ref.invocationId &&
            owner.executionId === ref.parentInvocationId &&
            owner.threadId === ref.threadId &&
            owner.catId === ref.catId &&
            owner.userId === userId,
        )
      )
        return;
      await cliExecutionOwnerService.terminateExact({ ...ref, executionId: ref.parentInvocationId, userId });
    },
    onExecutionReleased: (threadId) => {
      queueProcessor.requestDrain(threadId);
    },
  });
  router = new AgentRouter({
    ordinaryTaskHandoffs,
    messageSearchAnswerService,
    ownedWaitStatusReader,
    resolveTrustedImagePath: async (hmrId) => trustedImagePathResolver(hmrId),
    resolveInvocationPluginMcpView: () => pluginRuntime.supervisor.resolveMemberMcpView(),

    agentRegistry,
    registry,
    messageStore,
    threadExecutionSituationSource,
    taskProgressStore,
    ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    ...(threadStore ? { threadStore } : {}),
    sessionChainStore,
    contextEpochOwner,
    hookAuthenticationReady: sessionHookAuthenticationReady,
    claudeCompactionHooks,
    presentationLedger,
    runtimeSessionStore,
    transcriptWriter,
    transcriptReader,
    sessionSealer,
    draftStore,
    taskStore,
    ...(workflowSopStore ? { workflowSopStore } : {}),
    executionDigestStore,
    socketManager,
    ...(tmuxGateway ? { tmuxGateway } : {}),
    ...(agentPaneRegistry ? { agentPaneRegistry } : {}),
    packStore,
    evidenceStore: memoryServices.evidenceStore,
    ...(proactiveMemoryNudgeService ? { proactiveMemoryNudgeService } : {}),
    ...(humanDispositionFeedbackContextService ? { humanDispositionFeedbackContextService } : {}),
    ...(toolUsageCounter ? { toolUsageCounter } : {}),
    ...(toolEventLog ? { toolEventLog } : {}),
    ...(skillLoadEventLog ? { skillLoadEventLog } : {}),
    guideSessionStore,
    dismissTracker,
    worldContextProvider,
    worldStore,
    ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
    turnCustodyProjectionService,
    frustrationIssueStore,
    conciergeConfigStore: conciergeConfigStoreShared,
    conciergeTriagePlanStore,
    cloudInvokeBridge,
    dotReplyTarget: (source) => dotAskService?.replyTarget(source) ?? Promise.resolve(false),
    cloudReturnGrantStore,
    turnExecutionStore,
    ...(freshnessStateStore ? { freshnessStateStore } : {}),
    runtimeInteractionPort: runtimeInteractionRuntime.service,
    ...(freshnessEventLog ? { freshnessEventLog } : {}),
    ...(freshnessOutputCommitCoordinator ? { freshnessOutputCommitCoordinator } : {}),
    ...(injectionTraceStore ? { injectionTraceStore } : {}),
    personMemoryProposalStatusContextResolver: new PersonMemoryProposalStatusContextResolver(
      personMemoryStore,
      messageStore,
    ),
    contextSourceAdmission: memoryCueRuntime.contextSourceAdmission,
    memoryCuePromptService: memoryCueRuntime.promptService,
    profileCueOpportunitySource: memoryCueRuntime.profileOpportunitySource,
    eventCueOpportunitySource: memoryCueRuntime.eventOpportunitySource,
    threadOverviewOpportunitySource: memoryCueRuntime.threadOverviewOpportunitySource,
    profileRepository,
    ...(writeOpportunityTerminalLedger ? { writeOpportunityTerminalLedger } : {}),
    ...(writeOpportunityDeliveryStore ? { writeOpportunityDeliveryStore } : {}),
  });

  // F39: Message queue delivery
  // P2-1 fix: wire lazy ref now that InvocationQueue exists
  invocationQueueRef = invocationQueue;
  const sessionContinuationCoordinator = new SessionContinuationCoordinator({
    threadStore: {
      getMemberSessionStrategy: async (threadId, catId, userId) => {
        if (threadStore.getMemberSessionStrategy) {
          return (await threadStore.getMemberSessionStrategy(threadId, catId, userId)) ?? undefined;
        }
        if (threadStore.isRebornSession && (await threadStore.isRebornSession(threadId, catId))) {
          return 'reborn';
        }
        return undefined;
      },
      consumePendingContinuation: async (threadId, catId, userId) => {
        const entry = await threadStore.consumePendingContinuation(threadId, catId, userId);
        return (entry?.capsule as unknown as CollaborationContinuityCapsuleV1 | undefined) ?? null;
      },
      setPendingContinuation: async (threadId, catId, userId, capsule) => {
        await threadStore.setPendingContinuation(threadId, catId, userId, {
          capsule: capsule as unknown as Record<string, unknown>,
          createdAt: Date.now(),
        });
      },
    },
  });
  const deploymentWaitStartGuard = new DeploymentWaitStartGuard({
    taskStore,
    messageStore,
    handoffProposalStore,
    sessionChainStore,
    observationProvider: runtimeDeploymentContext?.provider ?? { observe: async () => null },
  });
  const queueProcessor = new QueueProcessor(
    {
      ordinaryTaskHandoffs,
      taskStore,
      queue: invocationQueue,
      liveCompanionSessions,
      invocationTracker,
      deploymentWaitStartGuard,
      invocationRecordStore: invocationRecordStore as unknown as InvocationRecordStoreLike,
      router: router as unknown as RouterLike,
      socketManager,
      messageStore,
      draftStore,
      turnExecutionStore,
      log: app.log,
      getPushService: getPushNotificationService,
      threadStore:
        threadStore as unknown as import('./domains/cats/services/agents/invocation/QueueProcessor.js').ThreadStoreLike,
      sessionContinuationCoordinator,
      freshnessEventLog,
      ...(actionSuccessorLeaseStore ? { actionSuccessorLeaseStore } : {}),
      deliveryCursorStore,
    },
    {
      callerDispatchProcessStart: {
        processGenerationId: `api:${PROCESS_START_AT}:${process.pid}`,
      },
    },
  );
  await runtimeInteractionRuntime.bindConversationReturnGateway(
    new MessageQueueRuntimeConversationReturnGateway({
      messageStore,
      queue: invocationQueue,
      socketManager,
      tryAutoExecute: (threadId) => queueProcessor.requestDrain(threadId),
    }),
  );
  app.addHook('onClose', async () => runtimeInteractionRuntime.dispose());
  const deliverApprovedActionCarrier = async (
    proposal: import('@cat-cafe/shared').DispatchProposal,
    fence: import('./domains/ball-custody/ActionSuccessorAdmissionService.js').ActionSuccessorFence,
    ownerAuthProvenance: import('./domains/cats/services/owner-auth-provenance.js').OwnerAuthProvenance,
  ): Promise<
    import('./domains/ball-custody/ActionSuccessorRecoverySweep.js').ActionSuccessorDispatchDeliveryResult
  > => {
    const actionSocketManager = socketManager;
    if (!actionSocketManager) return { outcome: 'unavailable' };
    const targetCatIds = proposal.targetCats as CatId[];
    const senderCatId = proposal.senderCatId as CatId;
    const messageInput = {
      from: { kind: 'agent', catId: senderCatId },
      userId: proposal.ownerUserId,
      content: proposal.content,
      mentions: targetCatIds,
      origin: 'callback',
      timestamp: Date.now(),
      threadId: proposal.targetThreadId,
      idempotencyKey: `dispatch-action:${proposal.proposalId}:message`,
      extra: {
        isExplicitPost: true as const,
        crossPost: {
          sourceThreadId: proposal.sourceThreadId,
          effectClass: 'assign_work' as const,
        },
        targetCats: targetCatIds,
      },
      ...(proposal.replyTo ? { replyTo: proposal.replyTo } : {}),
    } as const;
    const existingMessage = await messageStore.getByIdempotencyKey(
      proposal.ownerUserId,
      proposal.targetThreadId,
      messageInput.idempotencyKey,
    );
    const existingEntries = existingMessage
      ? ((await invocationQueue.getDurableEntriesForMessages(existingMessage.threadId, [existingMessage.id])).get(
          existingMessage.id,
        ) ?? [])
      : [];
    const existingTargets = new Set(existingEntries.flatMap((entry) => entry.targets));
    const freshTargetCatIds = targetCatIds.filter((catId) => !existingTargets.has(catId));
    const planned = planA2AFanoutAdmission(
      { invocationQueue },
      {
        targetCats: freshTargetCatIds,
        requestedTargetCats: targetCatIds,
        content: proposal.content,
        userId: proposal.ownerUserId,
        ownerAuthProvenance,
        threadId: proposal.targetThreadId,
        createdAt: messageInput.timestamp,
        callerCatId: senderCatId,
        isCrossThread: proposal.sourceThreadId !== proposal.targetThreadId,
        actionSuccessorFence: fence,
      },
    );
    const acceptedFresh = new Set(planned.acceptedTargetCats);
    const admissionPlan = {
      requestedTargetCats: targetCatIds,
      acceptedTargetCats: targetCatIds.filter((catId) => existingTargets.has(catId) || acceptedFresh.has(catId)),
      streakTargetCats: planned.streakTargetCats,
      ...(planned.stop ? { stop: planned.stop } : {}),
    };
    const atomicAdmission = await appendA2ASourceWithLedgerAdmission({ messageStore, invocationQueue }, messageInput, {
      plan: admissionPlan,
      ownerAuthProvenance,
      actionSuccessorFence: fence,
    });
    const storedMsg = atomicAdmission.message;
    const classifyPersistedCarrier = async (message: typeof storedMsg) => {
      const entries =
        (await invocationQueue.getDurableEntriesForMessages(message.threadId, [message.id])).get(message.id) ?? [];
      return { state: classifyApprovedActionCarrier(proposal, message, entries, fence), entries };
    };
    const persisted = await classifyPersistedCarrier(storedMsg);
    const persistedState = persisted.state;
    if (persistedState.outcome === 'conflict') {
      return {
        outcome: 'terminal_failure',
        reason: persistedState.reason,
        evidenceRef: `message:${storedMsg.id}`,
      };
    }
    if (
      persistedState.outcome === 'admitted' &&
      (storedMsg.deliveryStatus === 'delivered' || persisted.entries.every((entry) => entry.status === 'terminal'))
    ) {
      return { outcome: 'enqueued', deliveredMessageId: storedMsg.id };
    }
    let enqueueResult: Awaited<ReturnType<typeof enqueueA2ATargets>>;
    try {
      enqueueResult = await enqueueA2ATargets(
        {
          socketManager: actionSocketManager,
          messageStore,
          ...(invocationTracker ? { invocationTracker } : {}),
          ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
          queueProcessor,
          invocationQueue,
          log: app.log,
        },
        {
          targetCats: targetCatIds,
          content: proposal.content,
          userId: proposal.ownerUserId,
          ownerAuthProvenance,
          threadId: proposal.targetThreadId,
          triggerMessage: storedMsg,
          callerCatId: senderCatId,
          actionSuccessorFence: fence,
          preplannedAdmission: admissionPlan,
          ...(atomicAdmission.preAdmittedEntries
            ? {
                preAdmittedEntries: atomicAdmission.preAdmittedEntries,
                preAdmittedReplayed: atomicAdmission.preAdmittedReplayed,
              }
            : {}),
        },
      );
    } catch (error) {
      const racedMessage = await messageStore.getById(storedMsg.id);
      if (racedMessage) {
        const racedState = (await classifyPersistedCarrier(racedMessage)).state;
        if (racedState.outcome === 'admitted') {
          return { outcome: 'enqueued', deliveredMessageId: storedMsg.id };
        }
        if (racedState.outcome === 'conflict') {
          return {
            outcome: 'terminal_failure',
            reason: racedState.reason,
            evidenceRef: `message:${storedMsg.id}`,
          };
        }
      }
      throw error;
    }
    const accepted = new Set([...(enqueueResult.enqueued ?? []), ...(enqueueResult.coalesced ?? [])]);
    if (!targetCatIds.every((catId) => accepted.has(catId))) return { outcome: 'unavailable' };
    const admittedMessage = await messageStore.getById(storedMsg.id);
    if (!admittedMessage) return { outcome: 'unavailable' };
    const admittedState = (await classifyPersistedCarrier(admittedMessage)).state;
    if (admittedState.outcome === 'conflict') {
      return {
        outcome: 'terminal_failure',
        reason: admittedState.reason,
        evidenceRef: `message:${storedMsg.id}`,
      };
    }
    if (admittedState.outcome !== 'admitted') return { outcome: 'unavailable' };

    actionSocketManager.broadcastAgentMessage(
      {
        type: 'text',
        catId: senderCatId,
        content: proposal.content,
        origin: 'callback',
        messageId: storedMsg.id,
        extra: {
          isExplicitPost: true as const,
          crossPost: { sourceThreadId: proposal.sourceThreadId },
          targetCats: targetCatIds,
        },
        timestamp: Date.now(),
      },
      proposal.targetThreadId,
    );
    return { outcome: 'enqueued', deliveredMessageId: storedMsg.id };
  };
  if (actionSuccessorLeaseStore && actionSubjectTruthResolver) {
    const { ActionSuccessorRecoverySweep } = await import('./domains/ball-custody/ActionSuccessorRecoverySweep.js');
    actionSuccessorRecovery = new ActionSuccessorRecoverySweep({
      tasks: taskStore,
      leaseStore: actionSuccessorLeaseStore,
      deliverReturnCarrier: async (carrier) => {
        const invocationKey = actionSuccessorInvocationIdempotencyKey(carrier.idempotencyKey);
        const existing = await invocationRecordStore.getByIdempotencyKey(
          carrier.threadId,
          carrier.userId,
          invocationKey,
        );
        if (existing) {
          const recoveryStatus = classifyInvocationRecoveryStatus(existing.status);
          if (recoveryStatus === 'completed') {
            return { outcome: 'completed' as const, invocationId: existing.id };
          }
          if (recoveryStatus === 'in_flight') return { outcome: 'enqueued' as const };
          if (recoveryStatus === 'terminal') return { outcome: 'unavailable' as const };
        }

        const result = await invocationQueue.enqueueDurable({
          from: { kind: 'agent', catId: carrier.callerCatId },
          threadId: carrier.threadId,
          userId: carrier.userId,
          kind: 'private_input',
          ownerAuthProvenance: 'unknown',
          content: carrier.content,
          sourceCategory: 'a2a',
          targetCats: [carrier.targetCatId],
          intent: 'execute',
          autoExecute: true,
          priority: 'urgent',
          idempotencyKey: carrier.idempotencyKey,
          actionSuccessorFence: carrier.fence,
        });
        if (result.outcome !== 'enqueued') return { outcome: 'unavailable' as const };
        await queueProcessor.requestDrain(carrier.threadId);
        const admitted = await invocationRecordStore.getByIdempotencyKey(
          carrier.threadId,
          carrier.userId,
          invocationKey,
        );
        if (!admitted) return { outcome: 'enqueued' as const };
        const recoveryStatus = classifyInvocationRecoveryStatus(admitted.status);
        if (recoveryStatus === 'completed') {
          return { outcome: 'completed' as const, invocationId: admitted.id };
        }
        return recoveryStatus === 'terminal' ? { outcome: 'unavailable' as const } : { outcome: 'enqueued' as const };
      },
      dispatch: {
        tasks: taskStore,
        leaseStore: actionSuccessorLeaseStore,
        truthResolver: actionSubjectTruthResolver,
        loadProposal: (proposalId) => dispatchProposalStore.get(proposalId),
        loadOwnerAuthProvenance: (proposalId) => dispatchProposalStore.getApprovalOwnerAuthProvenance(proposalId),
        recordProposalDelivery: (proposalId, deliveredMessageId) =>
          dispatchProposalStore.recordDelivery(proposalId, deliveredMessageId),
        deliver: deliverApprovedActionCarrier,
      },
    });
    const runRecoveryCycle = createActionSuccessorRecoveryCycle({
      recoverReturns: () => actionSuccessorRecovery!.runOnce(),
      recoverDispatches: () => actionSuccessorRecovery!.runDispatchesOnce(),
      reconcileDoneTasks: () => taskActionSuccessorLifecycle?.reconcileDoneTasks(taskStore),
    });
    const runActionSuccessorRecovery = (): void => {
      void runRecoveryCycle()
        .then((stats) => {
          if (!stats) return;
          const [returnStats, dispatchStats, taskStats] = stats;
          if (returnStats.scanned > 0) {
            app.log.info({ ...returnStats }, 'F167 S.1-c ActionSuccessor return recovery sweep');
          }
          if (dispatchStats.scanned > 0) {
            app.log.info({ ...dispatchStats }, 'F246 approved ActionSuccessor carrier recovery sweep');
          }
          if (taskStats && taskStats.attempted > 0) {
            app.log.info({ ...taskStats }, 'F167 task ActionSuccessor completion recovery sweep');
          }
        })
        .catch((err: unknown) => {
          app.log.warn({ err }, 'F167 S.1-c ActionSuccessor return recovery sweep failed');
        });
    };
    runActionSuccessorRecovery();
    const actionSuccessorRecoveryTimer = setInterval(runActionSuccessorRecovery, 30_000);
    actionSuccessorRecoveryTimer.unref();
    app.addHook('onClose', async () => {
      clearInterval(actionSuccessorRecoveryTimer);
    });
  }
  // F117 KD-21: a turn ended by restart or zombie reclaim never reached its route's commit, so its
  // response R ends with the body its draft streamed. Settlement clears the turn from the
  // response-pending ledger; a turn whose settlement fails stays there for the next startup.
  const lifecycleSocket = socketManager;
  if (!lifecycleSocket) throw new Error('SocketManager unavailable for lifecycle response recovery');
  const settleTurnResponse = (
    turn: TurnExecutionRecord,
    outcome: Pick<Parameters<typeof settleResponseFromDraft>[1], 'status' | 'reason' | 'endedAt'>,
  ) =>
    settleResponseFromDraft(
      {
        messageStore,
        draftStore,
        turnStore: turnExecutionStore,
        invocationRecords: invocationRecordStore,
        commitFailedResponse: (response, patch) =>
          commitRecoveredFailedResponse(
            {
              socketManager: lifecycleSocket,
              queueProcessor,
              messageStore,
              invocationQueue,
              log: app.log,
            },
            response,
            patch,
          ),
        ...(lifecycleSocket
          ? {
              emit: (userId: string, message: StoredMessage) =>
                emitLifecycleMessageUpdated(lifecycleSocket, userId, message),
            }
          : {}),
      },
      { userId: turn.userId, threadId: turn.threadId, invocationId: turn.invocationId, ...outcome },
    );
  const onReconciledZombie = createZombieTerminalRecovery({
    queueProcessor,
    log: app.log,
    childResponses: {
      listChildTurns: (executionId) => turnExecutionStore.listByParent(executionId),
      settle: (turn) =>
        settleTurnResponse(turn, {
          status: 'interrupted',
          reason: 'zombie_record_detected',
          endedAt: turn.endedAt ?? Date.now(),
        }),
    },
  });
  const invocationOwnerSocketManager = socketManager;
  if (!invocationOwnerSocketManager) throw new Error('SocketManager unavailable for invocation owner reaper');
  const invocationOwnerReaper = new InvocationOwnerReaper({
    ...createExitedCliExecutionRecovery(invocationTracker),
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    getProviderLifecycle: getCodexAppServerLifecycle,
    listStaleProcessingLeases: (now) => queueProcessor.listStaleProcessingLeases(now),
    reapStalePrestartReservations: (now) => queueProcessor.reapStalePrestartReservations(now),
    ...('scanAll' in invocationRecordStore
      ? {
          listRunningRecords: async () =>
            (await invocationRecordStore.scanAll()).filter((record) => record.status === 'running'),
        }
      : {}),
    reconcileZombie: (zombie) =>
      reconcileZombies([zombie], {
        invocationRecordStore,
        taskProgressStore,
        ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
        log: app.log,
        onReconciledZombie,
        invocationQueue,
        onQueueConverged: (info) => {
          void emitQueueUpdated(
            invocationOwnerSocketManager,
            info.userId,
            info.threadId,
            invocationQueue.list(info.threadId, info.userId),
            'zombie_converged',
          ).catch((err) => app.log.warn({ err, feature: 'F118' }, 'zombie_converged broadcast failed'));
        },
      }),
    releaseExactOwner: (threadId, targetCats, executionId) => {
      queueProcessor.releaseExactTerminalExecutionOwner(threadId, targetCats, executionId);
    },
    log: app.log,
  });
  socketManager.setQueueProcessor(queueProcessor);

  // Register routes (socketManager injected, no circular import)
  const messagesOpts = {
    onStoredProjectMessage: async (
      message: import('./domains/cats/services/stores/ports/MessageStore.js').StoredMessage,
    ) => projectMessageProducer?.(message),
    registry,
    messageStore,
    socketManager,
    router,
    deliveryCursorStore,
    ...(sessionStore ? { sessionStore } : {}),
    threadStore,
    invocationTracker,
    summaryStore,
    draftStore,
    invocationQueue,
    sessionContinuationCoordinator,
    holdBallCancelDeps: { dynamicTaskStore, taskRunner: taskRunnerV2, messageStore, socketManager },
    // F192 Phase G AC-G12 / F227 归一: magic word → Event Memory (single truth
    // source) + a lightweight episode ref for F192's a2 projection.
    onMagicWordDetected: (
      hits: Array<{ word: string }>,
      threadId: string,
      catId: string | null,
      messageId: string,
      ownerUserId: string,
      messageExcerpt?: string,
    ) => {
      for (const hit of hits) {
        // 1) Write the full event FIRST. LL-048 / 砚砚: user-visible data — never
        //    silently swallow. On failure, dead-letter for replay (最终不丢);
        //    must not block message processing.
        const record: EventMemoryRecord = {
          type: hit.word,
          trigger: 'human_brake',
          cat: catId ?? 'unknown',
          threadId,
          messageId,
          timestamp: Date.now(),
          summary: messageExcerpt ?? hit.word,
          cognitiveTransition: 'user_brake',
          relatedHarness: null,
          confidence: 'high',
        };
        let eventId: string;
        try {
          const marked = memoryServices.eventMemoryStore.markEvent(record, ownerUserId);
          if (marked.suppressed) continue;
          eventId = marked.event.eventId;
        } catch (err) {
          // P1-3 (砚砚): dead-letter so the event is recoverable, not lost.
          try {
            memoryServices.eventMemoryStore.appendDeadLetter(record, ownerUserId, String(err));
          } catch (dlErr) {
            app.log.error({ dlErr, threadId, word: hit.word }, '[F227] dead-letter append ALSO failed');
          }
          app.log.error(
            { err, threadId, word: hit.word },
            '[F227] Event Memory write failed — dead-lettered for replay',
          );
          continue; // no orphan episode ref without a backing event
        }
        // 2) Episode ref = projection convenience for F192 a2 (secondary, best-effort).
        try {
          appendMagicWordRefToEpisode(taskOutcomeStore, {
            eventId,
            word: hit.word,
            threadId,
            catId: catId ?? 'unknown',
          });
        } catch (err) {
          app.log.error(
            { err, threadId, eventId },
            '[F227] episode magic_word_ref append failed (event already persisted)',
          );
        }
      }
    },
  };
  await app.register(messagesRoutes, messagesOpts);
  await app.register((await import('./routes/cloud-return-read.js')).cloudReturnReadRoutes, {
    messageStore,
    threadStore,
  });
  await app.register(messageBundleRoutes, { messageStore, threadStore });
  // F297 Phase B: 所有"什么在跑"的问题收口到同一个 domain service。
  //
  // 它比旧结构多做一件关键的事：**正向 working 投影**。live invocation / managed command /
  // running child 三张执行面各自既提名候选、也自己定性。旧结构把三源都塞进候选、却统一交给
  // 只认识 live invocation 的 classifier 定性，于是 managed command 与 standalone child
  // 候选进来、定性落空、presence=null，被终态回落误报成 done/error（R3 P1-1 / P1-2）。
  const activeExecutionService = createActiveExecutionService({
    invocationTracker,
    recordStore: invocationRecordStore,
    responseStatus: responseStatusFromMessages(messageStore), // F117 KD-23: a terminal R is not processing
    turnExecutionStore,
    dynamicTaskStore,
    log: app.log,
  });

  let contentControlReceipts: NativeControlReceiptPort | undefined;
  await app.register(queueRoutes, {
    controlReceipts: () => contentControlReceipts,
    threadStore,
    invocationQueue,
    queueProcessor,
    invocationTracker,
    resolveCarrierCapability: (catId) => router.freshnessCarrierCapability(catId),
    isCatAvailable: (catId) => isCatAvailable(catId),
    agentSessionMutex,
    socketManager,
    messageStore, // F117: for marking queued messages as canceled on withdraw/clear
    invocationRecordStore, // F194 Phase B: canonical liveness read source
    draftStore, // F117 KD-21: the streamed body a stopped response R settles with
    turnExecutionStore, // F194 + F117 KD-21: durable child turns and their response-pending ledger
    getManagedCommandWakeRecovery: () => managedCommandWakeRecovery,
    dynamicTaskStore, // F295: canonical managed-command execution read projection
    activeExecutionService, // F297 AC-D3: shared composition; project scan uses its live-candidate view
    cliExecutionOwnerService,
  });
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    turnExecutionStore,
  });
  await app.register(messageActionsRoutes, {
    messageStore,
    socketManager,
    threadStore,
    invocationQueue,
    queueProcessor,
    indexBuilder: memoryServices.indexBuilder,
  });
  // F155: Frontend-facing guide actions (no MCP auth, uses userId header)
  if (threadStore) {
    await app.register(guideActionRoutes, {
      threadStore,
      socketManager,
      guideSessionStore,
      dismissTracker,
    });
  }
  let assetCanonService: import('./domains/collaborative-content/asset-canon/service.js').AssetCanonService | undefined;
  let memberCanonService:
    | import('./domains/collaborative-content/asset-canon/member-service.js').MemberCanonService
    | undefined;
  await app.register(catsRoutes, {
    memberAssets: () => memberCanonService,
    resolveContextCapacitySnapshot: (catId) => router.contextCapacitySnapshot(catId),
    resolveCarrierCapability: (catId) => router.freshnessCarrierCapability(catId),
  });
  await app.register(routingContextRoutes, {
    ...(routingContextRuntime ? { runtime: routingContextRuntime } : {}),
  });

  // F182 Phase D: disable-impact endpoint
  {
    const { registerDisableImpactRoute } = await import('./routes/disable-impact.js');
    registerDisableImpactRoute(app, { taskStore, dynamicTaskStore });
  }

  // F149 Phase C: ACP pool diagnostics endpoint (gated by env flag)
  app.get('/api/diagnostics/acp-pool', async (_req, reply) => {
    if (process.env.CAT_CAFE_DIAGNOSTICS !== '1') {
      return reply.code(403).send({ error: 'Diagnostics disabled' });
    }
    const pools: Record<string, unknown> = {};
    for (const [variantId, pool] of acpPoolRegistry) {
      pools[variantId] = pool.getMetrics();
    }
    return { pools, poolCount: acpPoolRegistry.size };
  });

  await app.register(quotaRoutes, {
    ...(routingContextRuntime ? { routingQuotaObserver: routingContextRuntime.quotaSignalAdapter } : {}),
    routingOwnerId: privateUserId,
  });
  // F128: Daily token usage aggregation
  // F300: the cat's own coordinates, from the same source the UI reads.
  // The revision it reports as running is the one this process captured at startup,
  // the same value /health closes over -- never a fresh read of the build stamp on disk.
  await app.register(homeStateRoutes, {
    apiPort: PORT,
    runningRevision: runtimeDeploymentRevision,
    callbackRegistry: registry,
    agentKeyRegistry,
  });
  if (runtimeDeploymentContext) {
    await app.register(runtimeDeploymentRoutes, {
      ledger: runtimeDeploymentContext.ledger,
      deploymentId: runtimeDeploymentContext.deploymentId,
      onReady: () => runDeploymentWaitRecovery(),
    });
  }
  // F300 Task 2.1: the capability board for cats, read through the same pure
  // service as the Console's GET /api/capabilities, without its writes.
  await app.register(capabilitySnapshotRoutes, {
    callbackRegistry: registry,
    agentKeyRegistry,
    resolvePluginMcpView: () => pluginRuntime.supervisor.resolveMemberMcpView(),
  });
  await app.register(usageRoutes, { invocationRecordStore });
  // F150: Tool/Skill/MCP usage statistics
  if (toolUsageCounter) {
    await app.register(toolUsageRoutes, { toolUsageCounter });
  }
  // F268: Capability Tips telemetry pipeline (aggregate-only, no raw events stored)
  // P1-6: No-Redis → UnavailableTipEventSink returns 503 (prevents false durability ACK)
  {
    const { UnavailableTipEventSink, RedisTipEventSink } = await import('./routes/tip-telemetry.js');
    const tipSink = redis ? new RedisTipEventSink(redis) : new UnavailableTipEventSink();
    const { CapabilityTipsUsageAdapter } = await import(
      './infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    const tipUsage = redis ? new CapabilityTipsUsageAdapter(redis) : undefined;
    await app.register(tipTelemetryRoutes, {
      sink: tipSink,
      ...(tipUsage ? { readUsage: (selector) => tipUsage.resolve(selector) } : {}),
    });
  }
  // F200 Phase B: Recall metrics API
  const recallOwnerMessageSources = {
    tasteSources: {
      ownerUserId: privateUserId,
      repository: tasteRepository,
      lifecycle: tasteMemoryLifecycleStore,
      sourceReaders: { proposalStore: tasteProposalStore, threadStore, messageStore },
    },
    eventSources: { store: memoryServices.eventMemoryStore, sourceReaders: eventMemorySourceReaders },
  };
  await app.register(recallMetricsRoutes, {
    evidenceDb: memoryServices.store.getDb(),
    messageStore,
    threadStore,
    ...(personMemoryStore ? { personMemoryStore } : {}),
    cueSourceReader: memoryCueRuntime.sourceReader,
    profileMemoryStore: profileMemoryLifecycleStore,
    ...recallOwnerMessageSources,
  });
  const { memoryCueInvocationReadRoutes } = await import('./routes/memory-cue-invocation-read.js');
  await app.register(memoryCueInvocationReadRoutes, {
    evidenceDb: memoryServices.store.getDb(),
    threadStore,
    invocationRecordStore,
    turnExecutionStore,
  });
  const { memoryCueSourceSummaryRoutes } = await import('./routes/memory-cue-source-summary.js');
  await app.register(memoryCueSourceSummaryRoutes, { evidenceDb: memoryServices.store.getDb() });
  const { tasteObservatoryRoutes } = await import('./routes/taste-observatory.js');
  await app.register(tasteObservatoryRoutes, {
    evidenceDb: memoryServices.store.getDb(),
    tasteRepository,
    privateOwnerUserId: privateUserId,
    invocationRecordStore,
    turnExecutionStore,
    threadStore,
    lifecycleStore: tasteMemoryLifecycleStore,
  });
  const { TasteObservatoryReader } = await import('./domains/memory/taste/TasteObservatoryReader.js');
  const tasteBrowseStatistics = new TasteObservatoryReader(
    memoryServices.store.getDb(),
    tasteRepository,
    privateUserId,
    invocationRecordStore,
    turnExecutionStore,
    threadStore,
    tasteMemoryLifecycleStore,
  );
  const { tasteBrowseRoutes } = await import('./routes/taste-browse.js');
  await app.register(tasteBrowseRoutes, {
    ownerUserId: privateUserId,
    tasteRepository,
    proposalStore: tasteProposalStore,
    lifecycleStore: tasteMemoryLifecycleStore,
    lifecycleService: tasteMemoryLifecycleService,
    threadStore,
    messageStore,
    readObservatory: (owner, includePrivate) =>
      tasteBrowseStatistics.read(owner, { includePrivate, includeDimensionHints: true }),
  });
  await app.register(personMemoryOwnerReadRoutes, {
    ownerUserId: privateUserId,
    store: personMemoryStore,
    messageStore,
    threadStore,
  });
  await app.register(entityMemoryOwnerRoutes, {
    ownerUserId: privateUserId,
    store: entityMemoryLifecycleStore,
    lifecycle: entityMemoryLifecycleService,
    proposalStore: entityProposalStore,
    sourceReaders: entityMemorySourceReaders,
  });
  await app.register(profileMemoryOwnerRoutes, {
    ownerUserId: privateUserId,
    store: profileMemoryLifecycleStore,
    lifecycle: profileMemoryLifecycleService,
    proposalStore: profileUpdateProposalStore,
    sourceReaders: profileMemorySourceReaders,
  });
  // F153 Phase E: Hub embedded observability routes
  const { telemetryRoutes } = await import('./routes/telemetry.js');
  const { getGroundingSampleStore } = await import('./infrastructure/grounding/grounding-sample-singleton.js');
  await app.register(telemetryRoutes, {
    traceStore: telemetryHandle.traceStore,
    getMetricsText: telemetryHandle.getMetricsText ?? undefined,
    metricsSnapshotStore: telemetryHandle.metricsSnapshotStore ?? undefined,
    checkReadiness,
    groundingSampleStore: getGroundingSampleStore(),
  });
  // F192 Phase E-hub: harness eval verdict lifecycle surface.
  // F192 OQ-21: late-bound holder for the persisted Queue delivery port — eval-hub routes
  // register before invokeTrigger is created (line ~2600). Manual trigger route
  // resolves the live trigger at request time via this holder, so the provider
  // returns null until index.ts wires it after invokeTrigger construction.
  const invokeTriggerHolder: {
    current:
      | import('./domains/cats/services/agents/invocation/PersistedQueueDelivery.js').PersistedQueueDeliveryPort
      | null;
    get():
      | import('./domains/cats/services/agents/invocation/PersistedQueueDelivery.js').PersistedQueueDeliveryPort
      | null;
  } = {
    current: null,
    get() {
      return this.current;
    },
  };

  const { evalHubRoutes } = await import('./routes/eval-hub.js');
  const { evalVerdictLifecycleRoutes } = await import('./routes/eval-verdict-lifecycle.js');

  const evalHarnessFeedbackRoot = resolve(repoRoot, 'docs', 'harness-feedback');
  const reevalClosureEventLog = redis
    ? new (await import('./infrastructure/harness-eval/reeval-closure-event-log.js')).RedisReevalClosureEventLog(redis)
    : undefined;
  // F278: one durable disposition ledger shared by every projection and writer.
  // Without Redis, the routes remain visible but fail closed with 503 instead
  // of acknowledging non-durable review state.
  const pawFeelDispositionEventLog = redis ? new RedisPawFeelDispositionEventLog(redis) : undefined;
  const pawFeelReconciliationCoverageStore = redis ? new RedisPawFeelReconciliationCoverageStore(redis) : undefined;
  const pawFeelDutyConfigStore = redis ? new RedisPawFeelDutyConfigStore(redis) : undefined;
  const pawFeelDutyNoticeWatermarkStore = redis ? new RedisPawFeelDutyNoticeWatermarkStore(redis) : undefined;
  const pawFeelBundleSnapshotSigner = redis ? await loadOrCreatePawFeelBundleSnapshotSigner(redis) : undefined;
  const pawFeelLegacyCensusCursorSigner = redis
    ? await loadOrCreateLegacyPawFeelBlockerCensusCursorSigner(redis)
    : undefined;
  const pawFeelInboxAuditCursorSigner = redis ? await loadOrCreatePawFeelInboxAuditCursorSigner(redis) : undefined;
  const pawFeelFixResolver = new PawFeelFixEvidenceResolver({ leaseStore: actionSuccessorLeaseStore, taskStore });
  const pawFeelSourceVerifier = new PawFeelDirectRepairSourceVerifier({
    ownerUserId: privateUserId,
    messageStore,
    classifyTool: defaultPawFeelSourceToolClassifier,
  });
  // F313 D7: the first concrete route is exact and owner-backed. F287 rereads
  // the immutable operator authorization, its append-only outcome event, and Git
  // load truth; Task/F167 remains executable custody only.
  const memoryCuePawFeelDirectRepairRoute = MEMORY_CUE_PAW_FEEL_PROVIDER_ROUTE;
  const memoryCuePawFeelDirectRepairProvider = new MemoryCuePawFeelDirectRepairOwnerProvider({
    messageStore,
    episodeStore: memoryCueEpisodeStore,
    ownerUserId: privateUserId,
    loadedAtMs: PROCESS_START_AT,
    gitTruth: createMemoryCuePawFeelGitTruth({ repoRoot, loadedRevision: runtimeDeploymentRevision }),
  });
  const taskWorkflowPawFeelDirectRepairRoute = TASK_WORKFLOW_PAW_FEEL_PROVIDER_ROUTE;
  const taskWorkflowPawFeelDirectRepairProvider = new TaskWorkflowPawFeelDirectRepairOwnerProvider({
    messageStore,
    taskStore,
    threadStore,
    ownerUserId: privateUserId,
    gitTruth: createTaskWorkflowPawFeelGitTruth({ repoRoot, loadedRevision: runtimeDeploymentRevision }),
  });
  const pawFeelDirectRepairFederation = new PawFeelDirectRepairFederation([
    {
      route: memoryCuePawFeelDirectRepairRoute,
      provider: memoryCuePawFeelDirectRepairProvider,
    },
    {
      route: taskWorkflowPawFeelDirectRepairRoute,
      provider: taskWorkflowPawFeelDirectRepairProvider,
    },
  ]);
  const pawFeelDirectRepairBindingVerifier = new PawFeelDirectRepairBindingVerifier({
    sourceVerifier: pawFeelSourceVerifier,
    federation: pawFeelDirectRepairFederation,
  });
  const pawFeelSourceCaseActionResolver = reevalClosureEventLog
    ? new PawFeelSourceCaseActionResolver({
        harnessFeedbackRoot: evalHarnessFeedbackRoot,
        eventLog: reevalClosureEventLog,
        sourceVerifier: pawFeelSourceVerifier,
      })
    : undefined;
  const pawFeelDirectRepairResolver =
    pawFeelFixResolver && pawFeelSourceCaseActionResolver
      ? new PawFeelDirectRepairResolver({
          sourceVerifier: pawFeelSourceVerifier,
          federation: pawFeelDirectRepairFederation,
          custodyResolver: pawFeelFixResolver,
          approvalContinuationResolver: pawFeelSourceCaseActionResolver,
        })
      : undefined;
  const pawFeelDirectRepairOutcomeResolver = pawFeelFixResolver
    ? new PawFeelDirectRepairOutcomeResolver({
        bindingVerifier: pawFeelDirectRepairBindingVerifier,
        terminalResolver: {
          resolve: (projection, binding) => pawFeelFixResolver.resolveTerminal(projection, binding),
        },
      })
    : undefined;
  const pawFeelFollowUpResolver = new PawFeelContinuingResponsibilityResolver({
    ...(pawFeelFixResolver
      ? { repairProgressResolver: { resolve: (projection) => pawFeelFixResolver.resolveProgress(projection) } }
      : {}),
    directRepairBindingResolver: pawFeelDirectRepairBindingVerifier,
    ...(pawFeelSourceCaseActionResolver ? { sourceCaseResolver: pawFeelSourceCaseActionResolver } : {}),
  });
  const pawFeelResumeConditionResolver = new PawFeelCanonicalResumeConditionResolver(taskStore);
  const pawFeelDispositionReadModel =
    pawFeelDispositionEventLog && pawFeelReconciliationCoverageStore && pawFeelBundleSnapshotSigner
      ? new PawFeelDispositionReadModel({
          eventLog: pawFeelDispositionEventLog,
          messageStore,
          coverageStore: pawFeelReconciliationCoverageStore,
          bundleSnapshotSigner: pawFeelBundleSnapshotSigner,
          proposalStatusResolver: {
            isPending: async (proposalId) => (await proposalStore.get(proposalId))?.status === 'pending',
          },
          ...(pawFeelFixResolver ? { repairBindingResolver: pawFeelFixResolver } : {}),
          followUpResolver: pawFeelFollowUpResolver,
          semanticDegraded: () => memoryServices.embeddingService?.isReady() !== true,
        })
      : undefined;
  const pawFeelDispositionService = pawFeelDispositionEventLog
    ? new PawFeelDispositionService({
        eventLog: pawFeelDispositionEventLog,
        ...(pawFeelFixResolver ? { fixResolver: pawFeelFixResolver } : {}),
        ...(pawFeelDirectRepairResolver ? { directRepairResolver: pawFeelDirectRepairResolver } : {}),
        ...(pawFeelDirectRepairOutcomeResolver ? { repairOutcomeResolver: pawFeelDirectRepairOutcomeResolver } : {}),
        resumeConditionResolver: pawFeelResumeConditionResolver,
        ...(pawFeelDispositionReadModel ? { bundleMembershipResolver: pawFeelDispositionReadModel } : {}),
      })
    : undefined;
  const pawFeelInboxAuditScanService =
    pawFeelDispositionEventLog && pawFeelDispositionReadModel && pawFeelInboxAuditCursorSigner
      ? new PawFeelInboxAuditScanService({
          eventLog: pawFeelDispositionEventLog,
          readModel: pawFeelDispositionReadModel,
          signer: pawFeelInboxAuditCursorSigner,
        })
      : undefined;
  const pawFeelBlockerReconciler = pawFeelDispositionService
    ? new PawFeelBlockerReconciler({ service: pawFeelDispositionService })
    : undefined;
  const pawFeelLegacyCensusService =
    pawFeelDispositionService && pawFeelLegacyCensusCursorSigner
      ? new LegacyPawFeelBlockerCensusService({
          service: pawFeelDispositionService,
          signer: pawFeelLegacyCensusCursorSigner,
        })
      : undefined;
  const pawFeelCaptureService = pawFeelDispositionService
    ? new PawFeelCaptureService({ messageStore, dispositionService: pawFeelDispositionService })
    : undefined;
  const pawFeelCaptureIntentSidecar = pawFeelDispositionService
    ? new PawFeelCaptureIntentSidecar({ dispositionService: pawFeelDispositionService })
    : undefined;
  const pawFeelDutyReceiptService =
    pawFeelDutyNoticeWatermarkStore && pawFeelDispositionReadModel
      ? new PawFeelDutyReceiptService({
          watermarkStore: pawFeelDutyNoticeWatermarkStore,
          readResponsibilities: (signalIds) => pawFeelDispositionReadModel.readResponsibilities(signalIds),
          updateReceipt: async (messageId, rich) => {
            const updated = await messageStore.updateExtra(messageId, { rich });
            if (!updated) throw new Error(`paw-feel duty notice ${messageId} is unavailable for receipt update`);
          },
        })
      : undefined;
  if (pawFeelCaptureIntentSidecar && pawFeelDispositionService) {
    const previousAppendListener = appendListener;
    appendListener = (message) => {
      previousAppendListener?.(message);
      void captureAppendedPawFeelMessage(message, pawFeelCaptureIntentSidecar, pawFeelDispositionService).catch(
        (error) => {
          app.log.error(
            {
              err: error,
              sourceMessageId: message.id,
              turnInvocationId: message.extra?.stream?.turnInvocationId,
            },
            '[F278] paw-feel post-persist capture failed',
          );
        },
      );
    };
  }
  const pawFeelDispositionReconciler =
    pawFeelDispositionService && pawFeelReconciliationCoverageStore
      ? new PawFeelDispositionReconciler({
          messageStore,
          coverageStore: pawFeelReconciliationCoverageStore,
          dispositionService: pawFeelDispositionService,
        })
      : undefined;
  const { createA2aGeneratorAdapter } = await import(
    './infrastructure/harness-eval/publish-verdict/a2a-generator-adapter.js'
  );
  const { createTaskOutcomeGeneratorAdapter } = await import(
    './infrastructure/harness-eval/publish-verdict/task-outcome-generator-adapter.js'
  );
  const { createSopGeneratorAdapter } = await import(
    './infrastructure/harness-eval/publish-verdict/sop-generator-adapter.js'
  );

  // F192 Phase G: Task Outcome Episode store (SQLite). Constructed BEFORE the
  // verdictGenerators map because the F245 friction provider's CancelAdapter reads
  // it (listSignalsInWindow) — construction-ordering, F245 PR1b Decision 4.
  const { TaskOutcomeEpisodeStore } = await import('./infrastructure/harness-eval/task-outcome/task-outcome-store.js');
  const taskOutcomeDbPath = process.env.TASK_OUTCOME_DB ?? resolve(repoRoot, 'task-outcome-episodes.sqlite');
  const taskOutcomeStore = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);

  // F192 Phase H 收尾 PR-2 (砚砚 R1 P1 + Q5): capability-wakeup generator wires a real
  // CapabilityWakeupTrialProviderImpl with all 4 required ports (sessionStore /
  // transcriptReader / toolEventLog / skillLoadEventLog). Constructor fail-closed —
  // if Redis-backed ports are unavailable (no Redis client), skip cw wire entirely
  // (eval-cat-invocation domain instructions filtering will degrade gracefully:
  // cw cats see base instructions without publish section, handler returns 501).
  const { createQcGeneratorAdapter } = await import(
    './infrastructure/harness-eval/publish-verdict/qc-generator-adapter.js'
  );
  const verdictGenerators: Partial<Record<EvalDomainId, ReturnType<typeof createA2aGeneratorAdapter>>> = {
    'eval:a2a': createA2aGeneratorAdapter(),
    'eval:external-case-closure': createA2aGeneratorAdapter(),
    'eval:sop': createSopGeneratorAdapter(),
    'eval:task-outcome': createTaskOutcomeGeneratorAdapter(),
    'eval:qc': createQcGeneratorAdapter(),
  };
  let designGateEpisodeSourceProvider:
    | import('./infrastructure/harness-eval/design-gate/design-gate-episode-source-provider.js').DesignGateEpisodeSourceProviderImpl
    | undefined;
  {
    const { createDesignGateGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/design-gate-generator-adapter.js'
    );
    const { DesignGateEpisodeSourceProviderImpl } = await import(
      './infrastructure/harness-eval/design-gate/design-gate-episode-source-provider.js'
    );
    const { GitDesignGateTruth } = await import('./infrastructure/harness-eval/design-gate/design-gate-git-truth.js');
    designGateEpisodeSourceProvider = new DesignGateEpisodeSourceProviderImpl({
      repoRoot,
      reviewMessageReader: messageStore,
      gitTruth: new GitDesignGateTruth(repoRoot),
    });
    verdictGenerators['eval:design-gate'] = createDesignGateGeneratorAdapter(designGateEpisodeSourceProvider);
  }
  {
    const [
      { createTrajectoryInspectorGeneratorAdapter },
      { TrajectoryInspectorSourceProviderImpl },
      { GitTrajectoryInspectorArtifactTruth, RepoTrajectoryInspectorEvidenceSource },
      { resolveCanonicalInvocationTrajectory },
    ] = await Promise.all([
      import('./infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-generator-adapter.js'),
      import('./infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-source-provider.js'),
      import('./infrastructure/harness-eval/trajectory-inspector/trajectory-inspector-repo-evidence-source.js'),
      import('./domains/cats/services/session/CanonicalInvocationTrajectoryResolver.js'),
    ]);
    const trajectoryInspectorProvider = new TrajectoryInspectorSourceProviderImpl({
      threadStore,
      sessionChainStore,
      transcriptReader,
      externalEvidenceSource: new RepoTrajectoryInspectorEvidenceSource({
        harnessFeedbackRoot: evalHarnessFeedbackRoot,
        artifactTruth: new GitTrajectoryInspectorArtifactTruth(repoRoot),
      }),
      candidateLocator: async ({ invocationId, ownerUserId }) => {
        const execution = await turnExecutionStore.get(invocationId);
        return execution && execution.userId === ownerUserId
          ? { threadId: execution.threadId, catId: execution.catId }
          : undefined;
      },
      canonicalResolver: (input) =>
        resolveCanonicalInvocationTrajectory(input, {
          invocationRecordStore,
          turnExecutionStore,
          sessionChainStore,
          threadStore,
          readInvocationEvents: async (sessions, invocationId, signal) => {
            const owned = sessions.filter((session) => session.userId === input.userId);
            if (input.invocationEventsBySession) {
              return new Map(
                owned.map((session) => [
                  session.id,
                  (input.invocationEventsBySession?.get(session.id) ?? []).filter(
                    (event) => event.invocationId === invocationId,
                  ),
                ]),
              );
            }
            return transcriptReader.readInvocationEventsForSessions(owned, invocationId, signal);
          },
        }),
    });
    verdictGenerators['eval:trajectory-inspector'] =
      createTrajectoryInspectorGeneratorAdapter(trajectoryInspectorProvider);
  }
  {
    const { createFreshnessGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.js'
    );
    const { FreshnessReplayProviderImpl } = await import(
      './infrastructure/harness-eval/freshness/freshness-replay-provider.js'
    );
    verdictGenerators['eval:freshness'] = createFreshnessGeneratorAdapter(
      new FreshnessReplayProviderImpl({
        fixtureRoot: resolve(repoRoot, 'docs', 'harness-feedback', 'fixtures', 'f254'),
        queueLifecycleSource: invocationQueue,
        ...(freshnessEventLog ? { attentionEventLog: freshnessEventLog } : {}),
      }),
    );
  }
  if (toolEventLog && skillLoadEventLog) {
    const { createCapabilityWakeupGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/capability-wakeup-generator-adapter.js'
    );
    const { CapabilityWakeupTrialProviderImpl } = await import(
      './infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js'
    );
    const [{ createCapabilityWakeupRuntimeSessionEnumerator }, { projectInvocationPromptInput }] = await Promise.all([
      import('./infrastructure/harness-eval/capability-wakeup/capability-wakeup-session-enumerator.js'),
      import('./domains/cats/services/session/InvocationPromptInputProjector.js'),
    ]);
    const cwProvider = new CapabilityWakeupTrialProviderImpl({
      sessionStore: sessionChainStore,
      transcriptReader,
      promptReader: {
        read: async ({ threadId, catId, userId, invocationId }) => {
          const projection = await projectInvocationPromptInput(
            { messageStore, turnExecutionStore },
            { threadId, catId },
            invocationId,
            userId,
          );
          if (projection.status !== 'available') {
            if (projection.reason === 'prompt_message_ids_unavailable') {
              return {
                status: 'historical_unavailable' as const,
                reason: projection.reason,
              };
            }
            return {
              status: 'rejected' as const,
              reason: projection.reason,
            };
          }
          const prompt = projection.messages.find(
            (message) => message.status === 'available' && message.author === 'user',
          );
          if (prompt?.status === 'available') {
            return {
              status: 'available' as const,
              sourceMessageId: prompt.messageId,
              content: prompt.excerpt,
            };
          }
          const first = projection.messages[0];
          return {
            status: 'rejected' as const,
            reason: first && first.status !== 'available' ? first.status : 'non_user_prompt',
          };
        },
      },
      toolEventLog,
      skillLoadEventLog,
      sessionEnumerator: createCapabilityWakeupRuntimeSessionEnumerator({
        runtimeSessionStore,
        getFamilyForCat: (catId) => catRegistry.tryGet(catId)?.config.breedId,
      }),
    });
    verdictGenerators['eval:capability-wakeup'] = createCapabilityWakeupGeneratorAdapter(cwProvider);
  }

  // F192 publish_verdict eval:memory wire-up — wires MemoryMetricsProvider
  // backed by RecallMetricsComputer + computeLibraryHealth against live
  // evidenceDb + markerQueue. Constructor is cheap (pure ctor), so unconditional.
  if (memoryServices.markerQueue) {
    const { createMemoryGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/memory-generator-adapter.js'
    );
    const { MemoryMetricsProviderImpl } = await import(
      './infrastructure/harness-eval/memory/memory-metrics-provider-impl.js'
    );
    const memProvider = new MemoryMetricsProviderImpl({
      evidenceDb: memoryServices.store.getDb(),
      markersProvider: memoryServices.markerQueue,
      repoRoot,
      docsRoot,
    });
    verdictGenerators['eval:memory'] = createMemoryGeneratorAdapter(memProvider);
  }

  // F245 Phase C PR1b — friction live sink. Composes the 4 read-only channel
  // adapters (paw-feel / cancel / user-feedback / eval-domain) over live stores.
  // Pure ctor (cheap), so unconditional; embeddingService optional (clusterer
  // fail-opens to rule-only + degraded when absent/not-ready). KD-4: zero writeback.
  {
    const { createFrictionGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/friction-generator-adapter.js'
    );
    const { FrictionMetricsProviderImpl } = await import(
      './infrastructure/harness-eval/friction/friction-metrics-provider-impl.js'
    );
    const { createFrictionRepairTargetResolver } = await import(
      './infrastructure/harness-eval/friction/friction-repair-target-resolver.js'
    );
    const frictionProvider = new FrictionMetricsProviderImpl({
      messageStore,
      taskOutcomeStore,
      frustrationIssueStore,
      harnessFeedbackRoot: resolve(repoRoot, 'docs', 'harness-feedback'),
      ...(memoryServices.embeddingService ? { embeddingService: memoryServices.embeddingService } : {}),
    });
    verdictGenerators['eval:friction'] = createFrictionGeneratorAdapter(
      frictionProvider,
      createFrictionRepairTargetResolver({ threadStore, backlogStore, logger: app.log }),
    );
  }

  // F236 Track-2 — anchor-first eval domain. Pure ctor (no store deps), unconditional.
  // Provider wraps in-memory getAnchorTelemetryRollup(); generator writes rollup bundle.
  {
    const { createAnchorTelemetryGeneratorAdapter } = await import(
      './infrastructure/harness-eval/publish-verdict/anchor-telemetry-generator-adapter.js'
    );
    const { AnchorTelemetryProviderImpl } = await import(
      './infrastructure/harness-eval/anchor-first/anchor-telemetry-provider-impl.js'
    );
    const anchorProvider = new AnchorTelemetryProviderImpl();
    verdictGenerators['eval:anchor-first'] = createAnchorTelemetryGeneratorAdapter(anchorProvider);
  }

  // F192 Phase H AC-H4: real GitPublisher (git worktree + gh) + per-domain generators
  const { createGitWorktreePublisher } = await import(
    './infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js'
  );
  const verdictRepoFullName =
    process.env.CAT_CAFE_VERDICT_REPO_FULL_NAME ??
    process.env.CAT_CAFE_REPO_FULL_NAME ??
    deploymentDefaults.repositoryFullName;
  const harnessGitPublisher = createGitWorktreePublisher({
    repoRoot,
    expectedRepoFullName: verdictRepoFullName,
  });
  const capabilityEvolutionMeasurementGitPublisher = createGitWorktreePublisher({
    repoRoot,
    expectedRepoFullName: verdictRepoFullName,
    stageScope: 'capability-evolution-measurement',
  });

  await app.register(evalHubRoutes, {
    harnessFeedbackRoot: evalHarnessFeedbackRoot,
    threadStore,
    redis: redisClient ?? undefined,
    invokeTriggerProvider: invokeTriggerHolder,
    gitPublisher: harnessGitPublisher,
    verdictGenerators,
    // 砚砚 R4 P1 + cloud R4 P1: register CallbackAuthRegistry for MCP route auth.
    callbackRegistry: registry,
    // 砚砚 R9 P1: shared-MCP (Antigravity) agent-key publish path needs this.
    agentKeyRegistry,
    lifecycleEventLog: reevalClosureEventLog,
    taskOutcomeDbPath,
    eventMemoryDbPath: memoryServices.eventMemoryDbPath,
  });
  const { createEvalReleaseTruthResolver } = await import(
    './infrastructure/harness-eval/eval-release-truth-resolver.js'
  );
  const evalReleaseTruth = createEvalReleaseTruthResolver({ repoRoot: findMonorepoRoot(process.cwd()) });
  await app.register(evalVerdictLifecycleRoutes, {
    harnessFeedbackRoot: evalHarnessFeedbackRoot,
    eventLog: reevalClosureEventLog,
    redis: redisClient ?? undefined,
    callbackRegistry: registry,
    agentKeyRegistry,
    releaseTruth: evalReleaseTruth,
  });
  let evolutionRoundDispatch:
    | ((context: { programId: string }) => Promise<{ outcome: string; dedupeKey: string }>)
    | undefined;
  let evolutionObservationDispatch:
    | ((input: {
        programEventId: string;
        previousConnectedOwnerSurfaces: number;
        currentConnectedOwnerSurfaces: number;
      }) => Promise<unknown>)
    | undefined;
  // The Program is composed before F266/F313. This holder keeps Phase 4 dormant now while allowing
  // the later canonical owner composition to activate the existing service without reconstruction.
  let evolutionChangeOwner: EvolutionChangeOwnerPort | undefined;
  let evalRepairOutcomeService: EvalRepairOutcomeService | undefined;
  registerMicroduckLocalOwnerRuntime({ repoRoot: findMonorepoRoot(process.cwd()) });
  const evolutionProgramAdapterRegistry = new ProgramAdapterRegistry();
  const microduckRuntimeAdapter = createMicroduckRuntimeAdapter({
    proposalResolver: createMicroduckProposalResolver(reevalClosureEventLog),
    approvalResolver: createMicroduckApprovalResolver(reevalClosureEventLog),
  });
  evolutionProgramAdapterRegistry.register(microduckRuntimeAdapter);
  evolutionProgramAdapterRegistry.register(
    createDuckCapabilityPublicAdapter({ repoRoot: findMonorepoRoot(process.cwd()) }),
  );
  const requestReviewRepoRoot = findMonorepoRoot(process.cwd());
  const requestReviewOwnerPort = createRequestReviewOwnerPort({ repoRoot: requestReviewRepoRoot });
  const harnessHistoryOwner = redis
    ? new HarnessHistoryPublicationOwner({
        store: new RedisHarnessHistoryPublicationStore(redis),
        source: createHarnessHistoryGitSource({ repoRoot: requestReviewRepoRoot }),
      })
    : undefined;
  const catCafeSkillsSource = await resolveCatCafeSkillsSource();
  const requestReviewOwnerLedger = redis ? new RedisRequestReviewOwnerLedger(redis) : undefined;
  const requestReviewVersionReader = createRequestReviewCurrentVersionReader(requestReviewOwnerPort);
  const f266CaseActionResolver = reevalClosureEventLog
    ? new EvalRepairCaseActionResolver(evalHarnessFeedbackRoot, reevalClosureEventLog)
    : undefined;
  const requestReviewLineage = f266CaseActionResolver
    ? new RequestReviewLineageBindingResolver({
        readBindings: async () => (await loadRequestReviewEvalRepairOwnerBinding(repoRoot)).lineageBindings,
        resolveCaseAction: f266CaseActionResolver.resolve.bind(f266CaseActionResolver),
        versionReader: requestReviewVersionReader,
      })
    : undefined;
  const requestReviewUseReceipts = requestReviewOwnerLedger
    ? new RequestReviewUseReceiptService({
        ledger: requestReviewOwnerLedger,
        messageStore,
        invocationRegistry: registry,
        versionAttestor: createRequestReviewVersionAttestor({
          async resolveMount(invocationId) {
            const invocation = await registry.peekRecord(invocationId);
            if (!invocation) return null;
            const clientId = catRegistry.tryGet(invocation.catId)?.config.clientId;
            const mountPoint = clientId ? requestReviewMountPointForClient(clientId) : null;
            if (!mountPoint) return null;
            const thread = await threadStore.get(invocation.threadId);
            const projectRoot = thread?.projectPath ?? requestReviewRepoRoot;
            const mountRules = await readMountRules(projectRoot, requestReviewRepoRoot);
            const target = buildSkillMountTargets(projectRoot, homedir(), mountRules).find(
              (candidate) => candidate.id === mountPoint,
            );
            if (!target) return null;
            return {
              mountRoots: target.candidates,
              expectedSkillsRoot: join(projectRoot, 'cat-cafe-skills'),
              fallbackSkillsRoot: catCafeSkillsSource,
            };
          },
        }),
      })
    : undefined;
  const requestReviewOwnerReceipts =
    requestReviewOwnerLedger && reevalClosureEventLog && requestReviewLineage
      ? new RequestReviewOwnerReceiptService({
          eventLog: reevalClosureEventLog,
          ledger: requestReviewOwnerLedger,
          lineageBindingResolver: requestReviewLineage,
          versionVerifier: createRequestReviewCommitVersionVerifier(requestReviewOwnerPort),
          releaseTruth: evalReleaseTruth,
        })
      : undefined;
  const requestReviewOwnerFactAuthority =
    reevalClosureEventLog && actionSuccessorLeaseStore && requestReviewLineage
      ? new RequestReviewOwnerFactAuthority({
          eventLog: reevalClosureEventLog,
          taskStore,
          leaseStore: actionSuccessorLeaseStore,
          invocationRegistry: registry,
          lineageBindingResolver: requestReviewLineage,
        })
      : undefined;
  let requestReviewOwnerActions: ReturnType<typeof createRequestReviewOwnerActions> | undefined;
  const requestReviewOwnerAdapter = createRequestReviewOwnerAdapter({
    port: requestReviewOwnerPort,
    ...(harnessHistoryOwner ? { historyReader: harnessHistoryOwner.read.bind(harnessHistoryOwner) } : {}),
    ...(requestReviewOwnerLedger ? { ledger: requestReviewOwnerLedger } : {}),
    resolveActions: () => requestReviewOwnerActions,
  });
  evolutionProgramAdapterRegistry.register(requestReviewOwnerAdapter);
  const evolutionProgramService = redis
    ? await (async () => {
        const [
          { EvolutionProgramService },
          { RedisEvolutionProgramEventLog },
          { ProgramJoinValidator },
          { createProgramEvidenceProofResolver },
          { createProgramEvaluationOwnerResolver },
          { createFileMeasurementDecisionProofResolver },
          { createGitCapabilityEvolutionMeasurementBindingResolver },
          { createEvolutionOwnerSurfaceResolvers },
          { createEvolutionProgramTriggerRegistrationProvider },
          { resolveCanonicalInvocationTrajectory },
        ] = await Promise.all([
          import('./infrastructure/capability-evolution/program-service.js'),
          import('./infrastructure/capability-evolution/program-event-log.js'),
          import('./infrastructure/capability-evolution/program-join-validator.js'),
          import('./infrastructure/capability-evolution/program-evidence-proof-resolver.js'),
          import('./infrastructure/capability-evolution/program-evaluation-owner-resolver.js'),
          import('./infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.js'),
          import(
            './infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-binding-resolver.js'
          ),
          import('./infrastructure/capability-evolution/program-owner-surface-resolvers.js'),
          import('./infrastructure/capability-evolution/program-trigger-bridge.js'),
          import('./domains/cats/services/session/CanonicalInvocationTrajectoryResolver.js'),
        ]);
        const decisionProofResolver = createFileMeasurementDecisionProofResolver({
          repoRoot: findMonorepoRoot(process.cwd()),
        });
        const joinValidator = new ProgramJoinValidator({
          trajectoryResolver: async ({ ownerUserId, invocationId }) => {
            const result = await resolveCanonicalInvocationTrajectory(
              { userId: ownerUserId, invocationId },
              {
                invocationRecordStore,
                turnExecutionStore,
                sessionChainStore,
                threadStore,
                readInvocationEvents: (sessions, targetInvocationId, signal) =>
                  transcriptReader.readInvocationEventsForSessions(sessions, targetInvocationId, signal),
              },
            );
            return result.status === 200
              ? { status: 'resolved' as const, ...result.body }
              : { status: 'missing' as const };
          },
          sourceResolvers: createEvolutionOwnerSurfaceResolvers({
            pawFeelEventLog: pawFeelDispositionEventLog,
            humanDispositionLedger: humanDispositionLedger ?? undefined,
            messageStore,
            threadStore,
          }),
          evidenceProofResolver: createProgramEvidenceProofResolver({
            decisionProofResolver,
          }),
        });
        const triggerRegistration = createEvolutionProgramTriggerRegistrationProvider({
          harnessFeedbackRoot: evalHarnessFeedbackRoot,
        });
        return new EvolutionProgramService({
          eventLog: new RedisEvolutionProgramEventLog(redis),
          joinValidator,
          // Phase 3 evaluation reads owner truth from the same canonical F267 decision proofs.
          evaluationOwnerResolver: createProgramEvaluationOwnerResolver({ decisionProofResolver }),
          measurementConstitutionResolver: createGitCapabilityEvolutionMeasurementBindingResolver({
            repoRoot: findMonorepoRoot(process.cwd()),
          }),
          resolveChangeOwner: () => evolutionChangeOwner,
          triggerRegistration: () => (evolutionObservationDispatch ? triggerRegistration() : undefined),
          dispatchObservationTrigger: (input) => {
            if (!evolutionObservationDispatch) {
              throw new Error('F192 capability-evolution threshold dispatch is unavailable');
            }
            return evolutionObservationDispatch(input);
          },
          // A round opens only if F192 says it opened. The Program must never start one on its own
          // authority, so an unwired dispatcher reports `unavailable` rather than pretending.
          dispatchEvaluationTrigger: async (context: { programId: string }) => {
            if (!evolutionRoundDispatch) return { outcome: 'unavailable', dedupeKey: '' };
            return evolutionRoundDispatch(context);
          },
        });
      })()
    : undefined;
  if (evolutionProgramService) {
    registerMicroduckEvalRepairOwnerRuntime({
      registration: evalRepairOwnerRuntimeRegistration,
      ownerUserId: privateUserId,
      programReader: evolutionProgramService,
      invocationRegistry: registry,
      adapter: microduckRuntimeAdapter,
    });
    registerF311E0EvalRepairOwnerRuntime({
      registration: evalRepairOwnerRuntimeRegistration,
      repoRoot: findMonorepoRoot(process.cwd()),
      ownerUserId: privateUserId,
      programReader: evolutionProgramService,
      invocationRegistry: registry,
      connectEvolutionOwner(owner) {
        evolutionChangeOwner = owner;
      },
      connectOutcomeService(service) {
        evalRepairOutcomeService = service;
      },
    });
  }
  const capabilityEvolutionMeasurementIssuer = evolutionProgramService
    ? (
        await import(
          './infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js'
        )
      ).createCapabilityEvolutionMeasurementIssuer({
        repoRoot,
        programReader: evolutionProgramService,
        gitPublisher: capabilityEvolutionMeasurementGitPublisher,
      })
    : undefined;
  const evolutionProgramPreparationService =
    redis && evolutionProgramService
      ? new (
          await import('./infrastructure/capability-evolution/program-preparation-service.js')
        ).EvolutionProgramPreparationService({
          projectProgram: (events) => evolutionProgramService.project(events),
          eventLog: new (
            await import('./infrastructure/capability-evolution/program-event-log.js')
          ).RedisEvolutionProgramEventLog(redis),
          dependencies: {
            messageStore,
            threadStore,
            invocationReader: registry,
            publishMessage: (message) => {
              const invocationId = message.extra?.stream?.invocationId;
              if (!message.catId || !invocationId || !socketManager) return;
              socketManager.broadcastAgentMessage(
                {
                  type: 'text',
                  catId: message.catId,
                  content: message.content,
                  origin: 'callback',
                  messageId: message.id,
                  invocationId,
                  turnInvocationId: message.extra?.stream?.turnInvocationId ?? invocationId,
                  extra: {
                    isExplicitPost: true,
                    ...(message.extra?.causal ? { causal: message.extra.causal } : {}),
                  },
                  ...(message.replyTo ? { replyTo: message.replyTo } : {}),
                  timestamp: message.timestamp,
                },
                message.threadId,
              );
            },
          },
        })
      : undefined;
  await app.register(harnessHistoryRoutes, {
    service:
      harnessHistoryOwner && evolutionProgramService
        ? new HarnessHistoryPublicationService({
            owner: harnessHistoryOwner,
            service: evolutionProgramService,
            adapterRegistry: evolutionProgramAdapterRegistry,
            dependencies: { threadStore, invocationReader: registry },
          })
        : undefined,
    callbackRegistry: registry,
    agentKeyRegistry,
  });
  await app.register(capabilityEvolutionProgramRoutes, {
    service: evolutionProgramService,
    preparationService: evolutionProgramPreparationService,
    measurementIssuer: capabilityEvolutionMeasurementIssuer,
    callbackRegistry: registry,
    agentKeyRegistry,
    adapterRegistry: evolutionProgramAdapterRegistry,
    resolveOrigin: redis
      ? (
          await import('./infrastructure/capability-evolution/read-model/program-origin.js')
        ).createEvolutionProgramOriginResolver({
          eventLog: new (
            await import('./infrastructure/capability-evolution/program-event-log.js')
          ).RedisEvolutionProgramEventLog(redis),
          threadStore,
        })
      : undefined,
  });
  if (evalReleaseTruth.loadedRuntimeHead) {
    app.log.info(`[api] F266: release truth frozen at runtime HEAD ${evalReleaseTruth.loadedRuntimeHead}`);
  } else {
    app.log.warn('[api] F266: Git release truth unavailable; release-fact writes will fail closed');
  }
  await app.register(pawFeelDispositionRoutes, {
    ...(pawFeelDispositionReadModel ? { readModel: pawFeelDispositionReadModel } : {}),
    ...(pawFeelDispositionService ? { dispositionService: pawFeelDispositionService } : {}),
    ...(pawFeelCaptureService ? { captureService: pawFeelCaptureService } : {}),
    ...(pawFeelCaptureIntentSidecar ? { captureIntentSidecar: pawFeelCaptureIntentSidecar } : {}),
    ...(pawFeelDutyConfigStore ? { dutyConfigStore: pawFeelDutyConfigStore } : {}),
    ...(pawFeelDutyReceiptService ? { dutyReceiptService: pawFeelDutyReceiptService } : {}),
    callbackRegistry: registry,
    agentKeyRegistry,
  });
  await app.register(pawFeelInboxAuditScanRoutes, {
    ...(pawFeelInboxAuditScanService ? { auditScanService: pawFeelInboxAuditScanService } : {}),
    callbackRegistry: registry,
    agentKeyRegistry,
  });
  await app.register(pawFeelLegacyCensusRoutes, {
    ...(pawFeelLegacyCensusService ? { censusService: pawFeelLegacyCensusService } : {}),
    callbackRegistry: registry,
    agentKeyRegistry,
  });
  // AC-G13: Cancel burst detector (in-memory, per-process)
  const { buildProposalRejectSignal } = await import(
    './infrastructure/harness-eval/task-outcome/task-outcome-signal-builder.js'
  );
  const { appendMagicWordRefToEpisode, appendPrLifecycleEvidenceToEpisode } = await import(
    './infrastructure/harness-eval/task-outcome/task-outcome-signal-wiring.js'
  );
  const { taskOutcomeRoutes } = await import('./routes/task-outcome.js');
  await app.register(taskOutcomeRoutes, { store: taskOutcomeStore });

  // F153: Prompt X-Ray debug routes
  const { promptCaptureRoutes } = await import('./routes/prompt-captures.js');
  await app.register(promptCaptureRoutes);

  // F075 Phase B+C: Game + Achievement stores
  const { GameStore } = await import('./domains/leaderboard/game-store.js');
  const { AchievementStore } = await import('./domains/leaderboard/achievement-store.js');
  const gameStore = new GameStore();
  const achievementStore = new AchievementStore();
  await app.register(leaderboardRoutes, { messageStore, gameStore, achievementStore });
  await app.register(leaderboardEventsRoutes, { gameStore, achievementStore });
  await app.register(bootcampRoutes, { threadStore });
  await app.register(firstRunQuestRoutes, { threadStore });

  // F229: Concierge routes — reuse the shared conciergeConfigStoreShared created before AgentRouter.
  // Shared service lets threadsRoutes resolve the owner's canonical concierge carrier.
  // (threadStore.list cannot return concierge threads — they use createdBy='concierge-system').
  const { ConciergeThreadService } = await import('./domains/concierge/ConciergeThreadService.js');
  const conciergeThreadServiceShared = new ConciergeThreadService({
    threadStore,
    redis: redis ?? undefined,
    conciergeConfigStore: conciergeConfigStoreShared,
  });
  // F229 PR-A3b: relay + confirmation stores
  const { RedisConciergeRelayStore, MemoryConciergeRelayStore } = await import(
    './domains/concierge/ConciergeRelayStore.js'
  );
  const { RedisConciergeConfirmationStore, MemoryConciergeConfirmationStore } = await import(
    './domains/concierge/ConciergeConfirmationStore.js'
  );
  const conciergeRelayStore = redis ? new RedisConciergeRelayStore(redis) : new MemoryConciergeRelayStore();
  const conciergeConfirmationStore = redis
    ? new RedisConciergeConfirmationStore(redis)
    : new MemoryConciergeConfirmationStore();
  // F229 Phase B: triage plan store — already created above for AgentRouter, reuse here
  await app.register(conciergeRoutes, {
    conciergeConfigStore: conciergeConfigStoreShared,
    conciergeThreadService: conciergeThreadServiceShared,
    conciergeRelayStore,
    conciergeConfirmationStore,
    conciergeTriagePlanStore,
    conciergeInvestigationJobStore,
    evidenceStore: memoryServices?.evidenceStore,
    messageStore,
    withLiveConfigChange: createLiveConfigChange({
      store: conciergeConfigStoreShared,
      sessions: liveCompanionSessions,
      ownerUserId: privateUserId,
      revokeMedia: async () => {
        await pluginRuntime.desktopWindows?.revokeMedia();
      },
    }),
    isLiveConfigChangePending: (userId) => liveCompanionSessions.isChangingPreferences(userId),
  });
  const { companionDecisionRoutes } = await import('./routes/companion-decision-routes.js');
  const { readIgnoredItemPreferences } = await import('./config/user-preferences-ignored-items.js');
  const ignoredItemPreferenceProjectRoot = resolveActiveProjectRoot();
  let collectiveAttentionReader:
    | import('./routes/companion-collective-accountability-source.js').CollectiveAccountabilitySource
    | undefined;
  const readCollectiveAttention: import('./routes/companion-collective-accountability-source.js').CollectiveAccountabilitySource =
    (userId) => collectiveAttentionReader?.(userId) ?? Promise.resolve({ status: 503, body: {} });
  await app.register(companionDecisionRoutes, {
    collectiveAccountability: readCollectiveAttention,
    ownerUserId: privateUserId,
    messageStore,
    threadStore,
    runtimeInteractionStore: runtimeInteractionRuntime.store,
    readIgnoredItemPreferences: (ownerUserId) =>
      readIgnoredItemPreferences(ignoredItemPreferenceProjectRoot, ownerUserId),
    onResolved: (ownerUserId) =>
      socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId }),
  });
  let homeHub: import('./domains/concierge/live/host/home/home-hub-delivery.js').HomeHubDelivery | undefined;
  const artifactWorkLineageHolder: import('./domains/video-studio/content-owner/global-artifact-work-lineage.js').GlobalArtifactWorkLineageResolverHolder =
    {};
  const acceptedWorkspaceArtifactsHolder: import('./domains/collaborative-content/modification/accepted-workspace-artifacts.js').AcceptedWorkspaceArtifactReaderHolder =
    {};
  if (liveCompanionSessions) {
    const { createF317MeetingControlBundle } = await import('./routes/f317-meeting-control-bundle.js');
    const meetingControlBundle = createF317MeetingControlBundle(app, {
      ownerUserId: privateUserId,
      sessions: liveCompanionSessions,
      messages: messageStore,
      threadStore,
      isCurrentThread: (ownerId, threadId) => conciergeThreadServiceShared.isCurrent(ownerId, threadId),
    });
    const { f317LiveMeetingControlRoutes } = await import('./routes/f317-live-meeting-control.js');
    await app.register(f317LiveMeetingControlRoutes, { registry, service: meetingControlBundle.service });
    const { f317MeetingShareRoutes } = await import('./routes/f317-meeting-share.js');
    await app.register(f317MeetingShareRoutes, {
      ownerUserId: privateUserId,
      threadStore,
      host: liveCompanionSessions,
      service: meetingControlBundle.share,
    });
    const { installHomeActions } = await import('./domains/concierge/live/host/home/install-home-actions.js');
    const { createHomeWorkSource } = await import('./domains/concierge/live/host/home/home-work-source.js');
    const homeActions = await installHomeActions(app, {
      ownerUserId: privateUserId,
      sessions: liveCompanionSessions,
      messages: messageStore,
      threads: threadStore,
      registry,
      socketManager,
      isCurrentThread: (ownerId, threadId) => conciergeThreadServiceShared.isCurrent(ownerId, threadId),
      work: createHomeWorkSource({
        ownerUserId: privateUserId,
        isCurrentCompanionThread: (ownerId, threadId) => conciergeThreadServiceShared.isCurrent(ownerId, threadId),
        projectPath: () => resolveActiveProjectRoot(),
        messages: messageStore,
        threads: threadStore,
        tasks: taskStore,
        lineage: () => artifactWorkLineageHolder.current,
      }),
    });
    homeHub = homeActions.hub;
    const { maybeStartOwnerLocalNoteLab } = await import('./domains/concierge/live/host/owner-local-note-lab.js');
    const localNoteIsolation = {
      enabled: process.env.CAT_CAFE_F317_LOCAL_NOTE_LAB === '1',
      projectRoot: findMonorepoRoot(),
      apiPort: PORT,
      apiHost: HOST,
      memoryStore: process.env.MEMORY_STORE === '1',
      nodeEnv: process.env.NODE_ENV,
    };
    if (localNoteIsolation.enabled && process.env.CAT_CAFE_JEV_PAGE_CONFIG)
      throw new Error('Select one page-action composition; product and lab cannot share authority');
    const { readConfiguredPageAction } = await import('./domains/concierge/action/jev/page-action-config.js');
    const configuredPage = await readConfiguredPageAction();
    const localNoteLab = await maybeStartOwnerLocalNoteLab(localNoteIsolation);
    const { OwnerPageActionService } = await import('./domains/concierge/live/host/owner-page-action-service.js');
    const pageActionOwner = new OwnerPageActionService({
      ownerUserId: privateUserId,
      sessions: liveCompanionSessions,
      messages: messageStore,
      ...(configuredPage ?? (localNoteLab ? { profile: localNoteLab.profile, connector: localNoteLab.connector } : {})),
      recordResult: async ({ scope, requestMessageId, body, receiptId }) => {
        const result = await messageStore.appendIdempotent({
          userId: scope.userId,
          threadId: scope.threadId,
          from: { kind: 'system', service: 'live-page-action' },
          content: `[Host 页面操作回执｜来源 ${scope.threadId}#${requestMessageId}]\n${body}`,
          mentions: [],
          timestamp: Date.now(),
          idempotencyKey: `f317-page-action-${receiptId}`,
        });
        socketManager?.broadcastAgentMessage(
          {
            type: 'text',
            catId: scope.catId,
            content: result.message.content,
            messageId: result.message.id,
            invocationId: result.message.id,
            timestamp: result.message.timestamp,
          },
          scope.threadId,
        );
        return result.message.id;
      },
    });
    let localNoteSimulation: { stop(): Promise<void> } | undefined;
    if (localNoteLab) {
      app.log.info({ url: localNoteLab.url }, 'isolated local note trial admitted');
      app.addHook('onClose', async () => {
        const stopped = localNoteSimulation?.stop(); // revokes the call before physical cleanup begins
        const results = await Promise.allSettled([stopped, pageActionOwner.close(), localNoteLab.close()]);
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Isolated local note simulation cleanup unconfirmed');
      });
    }
    const { conciergeLiveRoutes } = await import('./routes/concierge-live.js');
    await app.register(conciergeLiveRoutes, {
      configStore: conciergeConfigStoreShared,
      ownerUserId: privateUserId,
      sessions: liveCompanionSessions,
      pageActionOwner,
      threadService: conciergeThreadServiceShared,
      sessionChainStore,
      messageStore,
      invocationQueue,
      recovery: {
        tasks: taskStore,
        approvals: { listSettled: (...args) => approvalProducerRegistry.listSettled(...args) },
        epochs: contextEpochStore,
      },
      mcpDistDir: join(findMonorepoRoot(), 'packages/mcp-server/dist'),
      // Keep native meeting exposure off until this package's Host/MCP/native lifecycle cut is verified together.
      meetingToolsEnabled: false,
      desktopRoot: join(findMonorepoRoot(), 'desktop/companion-live'),
      allowedDirectories: [join(resolveActiveProjectRoot(), 'docs')],
      publish: (message) => {
        if (message.catId)
          socketManager?.broadcastAgentMessage(
            {
              type: 'text',
              catId: message.catId,
              content: message.content,
              messageId: message.id,
              invocationId: message.id,
              extra: { ...message.extra, isExplicitPost: true },
              timestamp: message.timestamp,
            },
            message.threadId,
          );
        else
          socketManager?.emitToUser(message.userId, 'messages_delivered', {
            threadId: message.threadId,
            messageIds: [message.id],
            deliveredAt: message.timestamp,
            messages: [message],
          });
      },
    });
    const { f317PageActionRoutes } = await import('./routes/f317-page-action.js');
    await app.register(f317PageActionRoutes, { ownerUserId: privateUserId, service: pageActionOwner });
    const { f317LivePageActionRoutes } = await import('./routes/f317-live-page-action.js');
    await app.register(f317LivePageActionRoutes, { registry, service: pageActionOwner });
    if (localNoteLab) {
      try {
        const { startOwnerLocalNoteSimulation } = await import(
          './domains/concierge/live/host/owner-local-note-simulation.js'
        );
        localNoteSimulation = await startOwnerLocalNoteSimulation({
          isolation: localNoteIsolation,
          ownerUserId: privateUserId,
          sessions: liveCompanionSessions,
          service: pageActionOwner,
          messages: messageStore,
          threadService: conciergeThreadServiceShared,
          mcpDistDir: join(findMonorepoRoot(), 'packages/mcp-server/dist'),
          allowedDirectories: [join(resolveActiveProjectRoot(), 'docs')],
          apiUrl: `http://127.0.0.1:${PORT}`,
        });
      } catch (error) {
        const cleanup = await Promise.allSettled([pageActionOwner.close(), localNoteLab.close()]);
        if (cleanup.some((result) => result.status === 'rejected'))
          throw new Error('Isolated local note simulation startup cleanup unconfirmed', { cause: error });
        throw error;
      }
      app.log.info('isolated local note simulation admitted without native media');
    }
  }
  await app.register(dossierRoutes, { projectRoot: resolveActiveProjectRoot() });

  // F208 Phase D: operator observation staging layer (AC-D1)
  // Iron Rule #5: user-visible observations must persist (TTL=0). Redis required.
  // Fail-closed: no Redis → no observation routes (no silent data-loss mode).
  if (redisClient) {
    const { RedisDossierObservationStore } = await import(
      './domains/cats/services/stores/redis/RedisDossierObservationStore.js'
    );
    const dossierObservationStore = new RedisDossierObservationStore(redisClient);
    await app.register(dossierObservationRoutes, { observationStore: dossierObservationStore });
    // F208 Phase E: Distillation proposal store (AC-E1)
    // Same fail-closed pattern — no Redis → no distillation routes.
    const { RedisDossierDistillationProposalStore } = await import(
      './domains/cats/services/stores/redis/RedisDossierDistillationProposalStore.js'
    );
    const dossierDistillationStore = new RedisDossierDistillationProposalStore(redisClient);
    await app.register(dossierDistillationRoutes, { distillationStore: dossierDistillationStore });
  } else {
    app.log.warn(
      '[api] F208 dossier observations + distillation: routes NOT registered (Redis unavailable, fail-closed per Iron Rule #5)',
    );
  }

  // F208 Phase E AC-E2: Distillation checkpoint — in-memory opportunity store (transient workflow signals, not user data).
  // Always available regardless of Redis — opportunities are ephemeral prompts, not persistent user state.
  const { InMemoryOpportunityStore, DistillationCheckpoint } = await import(
    './infrastructure/distillation/DistillationCheckpoint.js'
  );
  const distillationOpportunityStore = new InMemoryOpportunityStore();
  const distillationCheckpoint = new DistillationCheckpoint({
    opportunityStore: distillationOpportunityStore,
    log: app.log,
  });
  await app.register(distillationOpportunityRoutes, { opportunityStore: distillationOpportunityStore });

  await app.register(brakeRoutes, { activityTracker });

  // F126: Create LimbRegistry + Phase B deps for device/hardware capability management
  const { LimbRegistry } = await import('./domains/limb/LimbRegistry.js');
  const { LimbAccessPolicy } = await import('./domains/limb/LimbAccessPolicy.js');
  const { LimbLeaseManager } = await import('./domains/limb/LimbLeaseManager.js');
  const { LimbActionLog } = await import('./domains/limb/LimbActionLog.js');
  const limbRegistry = new LimbRegistry();
  limbRegistry.setDeps({
    accessPolicy: new LimbAccessPolicy(),
    leaseManager: new LimbLeaseManager(),
    actionLog: new LimbActionLog(),
  });

  // F126 Phase C: Pairing store + limb node routes for remote devices
  const { LimbPairingStore } = await import('./domains/limb/LimbPairingStore.js');
  const { RedisApprovedLimbPairingPersistence } = await import('./domains/limb/ApprovedLimbPairingPersistence.js');
  const { registerLimbNodeRoutes } = await import('./routes/limb-node-routes.js');
  const limbPairingStore = redisClient
    ? await LimbPairingStore.restore(new RedisApprovedLimbPairingPersistence(redisClient))
    : new LimbPairingStore();
  registerLimbNodeRoutes(app, { limbRegistry, pairingStore: limbPairingStore });

  // F285 Phase B: raw-free physical observations enter through the paired
  // Remote Limb identity and a persistent one-body/one-cat binding.
  const { MemoryLimbEmbodimentBindingStore, RedisLimbEmbodimentBindingStore } = await import(
    './domains/limb/LimbEmbodimentBindingStore.js'
  );
  const { MemoryLimbObservationReceiptStore, RedisLimbObservationReceiptStore } = await import(
    './domains/limb/LimbObservationRouter.js'
  );
  const { registerLimbObservationRoutes } = await import('./routes/limb-observation-routes.js');
  const limbEmbodimentBindingStore = redisClient
    ? new RedisLimbEmbodimentBindingStore(redisClient)
    : new MemoryLimbEmbodimentBindingStore();
  const limbObservationReceiptStore = redisClient
    ? new RedisLimbObservationReceiptStore(redisClient)
    : new MemoryLimbObservationReceiptStore();
  let limbTranscriptDelivery: import('./domains/limb/LimbObservationRouter.js').LimbTranscriptDelivery | undefined;
  registerLimbObservationRoutes(app, {
    pairingStore: limbPairingStore,
    limbRegistry,
    bindingStore: limbEmbodimentBindingStore,
    receiptStore: limbObservationReceiptStore,
    delivery: {
      async deliverTranscript(input) {
        if (!limbTranscriptDelivery) {
          throw new Error('cat invocation runtime is not ready');
        }
        return limbTranscriptDelivery.deliverTranscript(input);
      },
    },
  });

  // F174 D2b-1 — single notifier instance shared between callback auth preHandler
  // (posts in-context surface on 401) and the hide-similar debug endpoint
  // (lets the user 24h-suppress a (reason, tool, catId) tuple).
  const callbackAuthNotifier = new CallbackAuthSystemMessageNotifier({ messageStore, socketManager });

  const namedCatContentHolder: import('./routes/callback-content-editor-routes.js').NamedCatContentHolder = {};
  const skillConsumptionReceipts = new SkillConsumptionReceiptService({
    skillSourceRoot: catCafeSkillsSource,
    auditLog: getEventAuditLog(),
  });
  // F167 #1449 Slice 2: durable hold quota store.
  // Redis mode (primary): shared authority across API nodes via sorted sets + Lua.
  // SQLite mode (MEMORY_STORE=1 only): per-node, for degraded/test environments.
  // No fallback: if Redis unavailable and not MEMORY_STORE=1, assertStorageReady
  // already threw above — this branch is unreachable but fail-closed for safety.
  let holdQuotaStore: IHoldQuotaStore;
  if (storageResult.mode === 'redis') {
    holdQuotaStore = new RedisHoldQuotaStore(redis!);
    app.log.info('[api] F167: hold quota store using Redis (shared authority)');
  } else {
    // MEMORY_STORE=1 degraded mode: SQLite :memory: (no cross-node claim)
    holdQuotaStore = createSqliteHoldQuotaStore(':memory:');
    app.log.info('[api] F167: hold quota store using SQLite :memory: (MEMORY_STORE=1 degraded)');
  }

  const callbackOpts = {
    ordinaryTaskHandoffs,
    ...(routingContextRuntime ? { routingSelection: routingContextRuntime.selectionService } : {}),
    proposalProjectRoot: resolveActiveProjectRoot(),
    companionCollectiveAccountability: readCollectiveAttention,
    resolveTrustedImagePath: async (hmrId: string) => {
      try {
        return await trustedImagePathResolver(hmrId);
      } catch {
        // A damaged private blob cannot become a path hint or fail the whole context read.
        return undefined;
      }
    },
    ...(liveCompanionSessions ? { companionProjectPath: resolveActiveProjectRoot() } : {}),
    ...(liveCompanionSessions
      ? {
          liveTaskAuthority: createLiveTaskAuthority(liveCompanionSessions, turnExecutionStore),
        }
      : {}),
    ...(liveCompanionSessions ? { companionRuntimeInteractionStore: runtimeInteractionRuntime.store } : {}),
    runtimeInteractionService: runtimeInteractionRuntime.service,
    ...(liveCompanionSessions
      ? { withLiveCarrierOperation: liveCompanionSessions.withCarrierOperation.bind(liveCompanionSessions) }
      : {}),
    ...(ballCustodyEventLog ? { ballCustodyEventLog } : {}),
    ...(liveCompanionSessions
      ? {
          liveExposureReason: (
            query: { invocationId: string; catId: string; threadId: string },
            message: import('./domains/cats/services/freshness/freshness-unseen-source.js').FreshnessReadableMessage,
          ) => liveCompanionSessions.exposureReason(query, message),
        }
      : {}),
    ...(liveCompanionSessions
      ? {
          isLiveCarrierInvocation: (query: { invocationId: string; catId: string; threadId: string }) =>
            liveCompanionSessions.isActiveCarrier(query),
        }
      : {}),
    registry,
    agentKeyRegistry,
    cloudReturnBindingSigner,
    cloudReturnGrantStore,
    admitDotAsk: async (input) => {
      if (!dotAskService) throw new Error('dot_ask_unavailable');
      return dotAskService.admit(input);
    },
    dotReplyTarget: (source) => dotAskService?.replyTarget(source) ?? Promise.resolve(false),
    admitDotReturn: async (input: {
      agentKeyId: string;
      userId: string;
      threadId: string;
      sourceMessageId: string;
      eventId: string;
      content: string;
    }) => {
      if (!dotReturnService) throw new Error('dot_connection_unavailable');
      return dotReturnService.admitReturn(input);
    },
    messageStore,
    threadExecutionSituationSource,
    socketManager,
    callbackAuthNotifier,
    taskStore,
    ownedWaitStatusReader,
    backlogStore,
    threadStore,
    conciergeConfigStore: conciergeConfigStoreShared,
    sessionChainStore,
    runtimeSessionStore,
    proposalStore,
    handoffProposalStore,
    profileUpdateProposalStore,

    namedCatContentHolder,
    ...(personMemoryStore
      ? {
          personMemoryStore,
          workspacePersonResolver,
          ...(deferredPersonMemoryReceiptStore ? { deferredPersonMemoryReceiptStore } : {}),
          ...(writeOpportunityDeliveryStore ? { writeOpportunityDeliveryStore } : {}),
          ...(writeOpportunityTerminalLedger ? { writeOpportunityTerminalLedger } : {}),
          ...(proactiveCandidateRegistryResolver ? { proactiveCandidateRegistryResolver } : {}),
        }
      : {}),
    memoryCueDeps,
    skillConsumptionDeps: {
      receipts: skillConsumptionReceipts,
      ...(requestReviewUseReceipts ? { requestReviewReceipts: requestReviewUseReceipts } : {}),
    },
    ...(requestReviewOwnerReceipts && requestReviewOwnerFactAuthority
      ? {
          requestReviewOwnerDeps: {
            ownerUserId: privateUserId,
            receipts: requestReviewOwnerReceipts,
            factAuthority: requestReviewOwnerFactAuthority,
            resolveOutcomeService: () => evalRepairOutcomeService,
          },
        }
      : {}),
    approvalIngress,
    profileRepository,
    agentRegistry,
    router,
    invocationRecordStore,
    turnExecutionStore,
    invocationTracker,
    deliveryCursorStore,
    ...(runtimeDeploymentContext
      ? {
          deploymentObservationProvider: runtimeDeploymentContext.provider,
          deploymentWaitLifecycleHolder,
        }
      : {}),
    ...(workflowSopStore ? { workflowSopStore } : {}),
    queueProcessor,
    invocationQueue,
    ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
    ...(actionSuccessorAdmissionService ? { actionSuccessorAdmissionService } : {}),
    ...(actionSuccessorLeaseStore ? { actionSuccessorLeaseStore } : {}),
    ...(taskActionSuccessorOrphanRecovery ? { taskActionSuccessorOrphanRecovery } : {}),
    indexBuilder: memoryServices.indexBuilder as
      | { markThreadDirty(threadId: string): void; flushDirtyThreads?(): number | Promise<number> }
      | undefined,
    messageSearchAnswerService,
    messageSearchService,
    evidenceStore: memoryServices.evidenceStore,
    markerQueue: memoryServices.markerQueue,
    reflectionService: memoryServices.reflectionService,
    limbRegistry,
    limbPairingStore,
    limbEmbodimentBindingStore,
    guideSessionStore,
    labelStore,
    dispatchProposalStore,
    redis, // F254 Phase B: raw Redis for freshness notice event log + state store
    holdBallDeps: {
      registry,
      ownerUserId: privateUserId,
      taskRunner: taskRunnerV2,
      templateRegistry,
      dynamicTaskStore,
      scheduleMutationAuditStore: scheduleMutationProposalStore,
      messageStore,
      socketManager,
      threadStore,
      taskStore,
      invocationRecordStore,
      ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
      ...(ballCustodyEventLog && ballCustodyProjectionStore
        ? { custodyEventInspector: new CustodyEventInspector({ ballCustodyEventLog, ballCustodyProjectionStore }) }
        : {}),
      holdQuotaStore,
      onHoldBallCancelFeedback: (input) => {
        void import('./domains/cats/services/frustration/FrustrationDetector.js')
          .then(({ evaluate }) =>
            evaluate(
              {
                signal: {
                  type: 'user_report',
                  toolName: 'cat_cafe_hold_ball',
                  cancelReason: 'hold_ball_cancel',
                },
                threadId: input.threadId,
                userId: input.userId,
                catId: input.catId,
              },
              { frustrationIssueStore, messageStore, socketManager: socketManager ?? undefined },
            ),
          )
          .catch(() => {
            // Best-effort: hold cancellation must not be blocked by feedback issue creation.
          });
      },
    },
  } as Parameters<typeof callbacksRoutes>[1];
  await app.register(callbacksRoutes, callbackOpts);
  // F306 Phase B: member MCP gateway — loopback Streamable HTTP MCP for ACP
  // members (iCode), authenticated per invocation against the live registry.
  registerMemberMcpRoutes(app, {
    registry,
    resolveMemberToolFamilies: ({ catId, sharedContext }) =>
      resolveMemberToolFamiliesForCat(
        sharedContext?.capabilityRoot ?? resolveActiveProjectRoot(),
        catId,
        sharedContext?.workspaceRoot,
      ),
    apiBaseUrl: `http://127.0.0.1:${PORT}`,
    deploymentId: sharedMcpDeploymentId(`http://127.0.0.1:${PORT}`),
    log: app.log,
  });
  await app.register(callbackRuntimeInteractionRoutes, {
    registry,
    callbackAuthNotifier,
    service: runtimeInteractionRuntime.service,
  });

  // F174 Phase D1 — callback auth failure telemetry debug endpoint (AC-D3).
  // D2b-1 adds POST /api/debug/callback-auth/hide-similar (24h opt-out) when notifier is wired.
  registerCallbackAuthDebugRoute(app, { notifier: callbackAuthNotifier });

  const sidebarPresenceSource = createSidebarPresenceSource({
    buildSnapshot: (userId) => activeExecutionService.buildSnapshot(userId),
    resolveWorkingPresence: (threadId, userId, snapshot) =>
      activeExecutionService.resolveWorkingPresence(threadId, userId, snapshot),
    listLatestTerminalExecutions: async (threadIds, userId) => {
      const records = await invocationRecordStore.listLatestTerminalByThreadIds(threadIds, userId);
      const terminal = new Map<string, SidebarTerminalExecution>();
      for (const [threadId, record] of records) {
        if (record.status !== 'succeeded' && record.status !== 'failed' && record.status !== 'canceled') continue;
        terminal.set(threadId, {
          status: record.status,
          ...(record.successfulCatIds ? { successfulCatIds: record.successfulCatIds } : {}),
        });
      }
      return terminal;
    },
  });

  await app.register(threadsRoutes, {
    threadStore,
    presenceSource: sidebarPresenceSource,
    messageStore,
    taskStore,
    memoryStore,
    sessionChainStore,
    transcriptWriter,
    artifactWorkLineage: artifactWorkLineageHolder,
    acceptedWorkspaceArtifacts: acceptedWorkspaceArtifactsHolder,
    deliveryCursorStore,
    invocationQueue,
    queueProcessor,
    socketManager,
    invocationTracker,
    draftStore,
    taskProgressStore,
    backlogStore,
    ...(readStateStore ? { readStateStore } : {}),
    guideSessionStore,
    labelStore,
    indexBuilder: memoryServices.indexBuilder as
      | { markThreadDirty(threadId: string): void; flushDirtyThreads?(): number | Promise<number> }
      | undefined,
    conciergeThreadService: conciergeThreadServiceShared,
  });
  await app.register(routingPreviewRoutes, { threadStore, router });
  await app.register(labelsRoutes, { labelStore, threadStore });
  await app.register(threadBranchRoutes, {
    threadStore,
    messageStore,
    socketManager,
  });
  await app.register(threadExportRoutes, { threadStore, messageStore });
  await app.register(threadMemberStrategyRoutes, { threadStore }); // #921
  await app.register(threadMemberEffortRoutes, { threadStore }); // F262
  await app.register(threadMemberSpeedRoutes, { threadStore }); // F291
  // F192: Shared callback — record proposal rejection as task outcome A2 signal.
  // Covers both F128 (thread proposal) and F225 (session handoff proposal) rejections.
  const onProposalReject = (input: {
    proposalId: string;
    proposalType: 'thread' | 'session_handoff';
    catId: string;
    threadId: string;
    proposalTitle?: string;
    rejectionReason?: string;
  }) => {
    try {
      const record = buildProposalRejectSignal(input);
      const episode =
        taskOutcomeStore.getActiveEpisodeByAttribution({
          attribution: 'unmanaged_not_applicable',
          threadId: input.threadId,
        }) ??
        taskOutcomeStore.createEpisode({
          trigger: 'cat_initiated',
          threadId: input.threadId,
          participants: input.catId ? [input.catId] : [],
          attribution: 'unmanaged_not_applicable',
        });
      taskOutcomeStore.appendSignal(episode.episodeId, { category: 'a2', record });
    } catch {
      // Best-effort: eval signal recording must not break the rejection flow
    }
  };

  await app.register(proposalRoutes, {
    projectRoot: resolveActiveProjectRoot(),
    proposalStore,
    threadStore,
    messageStore,
    socketManager,
    router,
    invocationQueue,
    onProposalReject: (input) => onProposalReject({ ...input, proposalType: 'thread' }),
  });
  // F231 Phase C: profile-update approve/reject (user-auth; locked critical section in service)
  registerProfileUpdateDecisionRoutes(app, {
    store: profileUpdateProposalStore,
    lock: profileUpdateLock,
    repository: profileRepository,
    socketManager,
    refreshProfileCollectionIndex:
      memoryServices.catalog && memoryServices.collectionStores
        ? (userId: string) =>
            refreshCanonicalProfileIndex(memoryServices.collectionStores!, memoryServices.catalog!, {
              dataDir: memoryServices.dataDir!,
              userId,
            })
        : undefined,
  });
  // F225: cat-initiated session handoff approve/reject (user-auth commit-point dispatcher)
  await app.register(sessionHandoffApproveRoutes, {
    handoffProposalStore,
    sessionChainStore,
    sessionSealer,
    invocationQueue,
    queueProcessor,
    socketManager,
    onProposalReject: (input) => onProposalReject({ ...input, proposalType: 'session_handoff' }),
  });
  // Shared generic binding index: plugin thread lookup, thread cats and the legacy connector path
  // must observe one truth while the legacy path still exists during cutover.
  const { RedisConnectorThreadBindingStore } = await import(
    './infrastructure/connectors/RedisConnectorThreadBindingStore.js'
  );
  const { MemoryConnectorThreadBindingStore } = await import(
    './infrastructure/connectors/ConnectorThreadBindingStore.js'
  );
  const connectorBindingStore = redisClient
    ? new RedisConnectorThreadBindingStore(redisClient)
    : new MemoryConnectorThreadBindingStore();
  // Seed only an absent registry before plugin activation can persist schedules
  // into it. Native invoke-time MCP resolution must work without visiting Settings.
  const { initializeFirstRunCapabilities } = await import('./config/capabilities/first-run-capabilities.js');
  const pluginCapabilityRoot = await resolveInvokeCapabilityRoot(runtimeEntrypointRoot);
  const capabilityInitialization = await initializeFirstRunCapabilities(pluginCapabilityRoot, runtimeEntrypointRoot);
  if (capabilityInitialization.status === 'unreadable') {
    app.log.warn('[api] Existing capabilities are unreadable; preserved without enabling default tools');
  }

  const { createPluginManagerRuntimeComposition } = await import('./domains/plugin/runtime-composition.js');
  const pluginProjectRoot = resolveActiveProjectRoot();
  const { buildDeliveryPresentation } = await import('./domains/messaging/lifecycle-delivery.js');
  const frontendBaseUrl = resolveFrontendBaseUrl(process.env, app.log);
  const deliveryThreadMeta = async (threadId: string) => {
    const thread = await threadStore.get(threadId);
    if (!thread) return undefined;
    return {
      threadShortId: threadId.slice(0, 15),
      ...(thread.title == null ? {} : { threadTitle: thread.title }),
      deepLinkUrl: buildThreadDeepLink(frontendBaseUrl, threadId),
    };
  };
  const deliveryPresentation = async (
    threadId: string,
    actor: { kind: 'cat' | 'user' | 'plugin' | 'device' | 'system'; id: string },
  ) =>
    buildDeliveryPresentation(
      threadId,
      {
        ...actor,
        ...(actor.kind === 'cat'
          ? { displayName: catRegistry.tryGet(actor.id as CatId)?.config.displayName ?? actor.id }
          : actor.kind === 'user'
            ? { displayName: getCoCreatorConfig().name }
            : {}),
      },
      await deliveryThreadMeta(threadId),
    );
  const { DesktopWindowComponent } = await import('./domains/plugin/desktop-window-runtime/desktop-component.js');
  const { ElectronDesktopWindowExecutor } = await import(
    './domains/plugin/desktop-window-runtime/electron-executor.js'
  );
  const { CompanionHostBridge } = await import('./domains/concierge/live/CompanionHostBridge.js');
  const { CompanionAppAssistOwner } = await import('./domains/concierge/live/host/companion-app-assist-owner.js');
  const { CompanionWorkOverview } = await import('./domains/concierge/live/work/companion-work-overview.js');
  const { resolveCompanionWorkPublication } = await import(
    './domains/concierge/live/host/home/companion-work-publication.js'
  );
  const { assertCompanionWorkProject } = await import('./domains/concierge/live/host/companion-work-port.js');
  const { companionDecisionUrl, createCompanionDecisionNavigation, createCompanionDecisionSocketDelivery } =
    await import('./domains/concierge/live/host/unified/companion-decision-navigation.js');
  const companionDesktopRoot = join(findMonorepoRoot(), 'desktop');
  const companionDesktopComponent = new DesktopWindowComponent({
    desktopRoot: companionDesktopRoot,
    cacheRoot: join(resolveActiveProjectRoot(), '.cat-cafe', 'components', 'desktop-window'),
  });
  const { DotConnectionService } = await import('./domains/cats/services/cloud-bridge/dot/DotConnectionService.js');
  const { DotConnectionRuntime } = await import('./domains/cats/services/cloud-bridge/dot/DotConnectionRuntime.js');
  let dotConnectionService: InstanceType<typeof DotConnectionService> | undefined;
  let dotRoundTripVerified = async () => false;
  const preparedArtifactReader = new F232PreparedArtifactReader({
    messages: messageStore,
  });
  const collectiveMaterialSourceHolder: import('./domains/plugin/host-surface/collective-material-source.js').CollectiveMaterialSourceHolder =
    {};
  const collectiveArtifactOwnerHolder: import('./domains/plugin/host-surface/collective-artifact-owner.js').CollectiveArtifactOwnerHolder =
    {};
  const pluginRuntime = cloudConversations.createRuntime({
    agentSessionProviders: (packages, configuration) =>
      declaredAgentSessionProviders({
        configuration,
        log: app.log,
        settings: sessionContractSettings,
        packages,
        registry: sessionImplementations,
        services: registeredSessionServices,
        createProvider: (declaration, { catId }) =>
          createRefreshingAcpSessionProvider({
            catId,
            scope: acpPoolRegistry,
            revision: () => sessionConfigurationRevision,
            createService: () => {
              const config = catRegistry.getAllConfigs()[catId];
              if (!config) throw new Error('Plugin ACP member unavailable');
              return createAcpServiceForConfig({
                projectRoot: resolveActiveProjectRoot(),
                profileId: catId,
                config,
                effectiveModel: getCatModel(catId),
                acpConfig: declaration.acp,
                poolRegistry: acpPoolRegistry,
                log: app.log,
              });
            },
          }),
      }),
    collectiveArtifactOwner: collectiveArtifactOwnerHolder,
    collectiveMaterialSource: collectiveMaterialSourceHolder,
    taskArtifactReader: preparedArtifactReader,
    limbRegistry,
    taskRunner: {
      registerPostStart: (task) => taskRunnerV2.registerPostStart(task),
      unregister: (taskId) => taskRunnerV2.unregister(taskId),
    },
    builtinRuntimes: new Map([
      [
        'official.chatgpt-dot',
        new DotConnectionRuntime(
          () => dotConnectionService,
          () => dotRoundTripVerified(),
        ),
      ],
    ]),
    projectRoot: pluginProjectRoot,
    capabilityProjectRoot: pluginCapabilityRoot,
    binaryProjectRoot: runtimeEntrypointRoot,
    editorParentOrigin: new URL(resolveFrontendBaseUrl(process.env, app.log)).origin,
    desktopExecutor: {
      prepare: async () => {
        await companionDesktopComponent.prepare();
      },
      open: async (launch) =>
        new ElectronDesktopWindowExecutor({
          executable: await companionDesktopComponent.executable(),
          entrypoint: join(companionDesktopRoot, 'plugin-window', 'main.cjs'),
          onStage: (stage) => app.log.info({ stage }, 'companion desktop lifecycle'),
          onFailure: ({ phase, reason, lastStage }) =>
            app.log.warn({ phase, reason, lastStage }, 'companion desktop startup failed'),
        }).open(launch),
    },
    onDesktopFailure: (pluginInstanceId, failure) =>
      app.log.warn(
        {
          pluginInstanceId,
          phase: 'running',
          reason: failure.reason,
          exitCode: failure.exitCode,
          signal: failure.signal,
          pid: failure.pid ?? null,
          lastStage: failure.lastStage ?? null,
          initiator: failure.initiator ?? null,
          observation: failure.observation ?? null,
        },
        'companion desktop runtime lost',
      ),
    createCompanionBridge: ({ assertCurrent, navigate, publicCompanionV2, companionContract, disableCompanion }) => {
      // The existing Host runtime composition owns this project binding. Renderer commands cannot select it.
      const assertWorkCurrent = async () => {
        await assertCurrent();
        assertCompanionWorkProject(pluginProjectRoot, resolveActiveProjectRoot());
      };
      const decisions = createCompanionDecisionNavigation({
        ownerUserId: privateUserId,
        messages: messageStore,
        threads: threadStore,
        assertCurrent: assertWorkCurrent,
        openBrowser: (destination) =>
          navigate(companionDecisionUrl(destination, resolveFrontendBaseUrl(process.env, app.log))),
        ...createCompanionDecisionSocketDelivery({
          ownerUserId: privateUserId,
          parseCookie: (header) => app.parseCookie(header),
          sockets: () => socketManager?.getIO().sockets.sockets.values() ?? [],
        }),
      });
      const openConversation = (threadId: string) =>
        navigate(new URL(`/thread/${encodeURIComponent(threadId)}`, resolveFrontendBaseUrl(process.env, app.log)).href);
      // Architecture cell: concierge-surface
      // Reuses Task/Message/Artifact owners; the Hub owns navigation and visible-version receipts.
      const workOptions = {
        ownerUserId: privateUserId,
        projectPath: pluginProjectRoot,
        tasks: taskStore,
        messages: messageStore,
        threads: threadStore,
        assertCurrent: assertWorkCurrent,
        artifactLineage: {
          resolve: (input: Parameters<NonNullable<typeof artifactWorkLineageHolder.current>['resolve']>[0]) => {
            if (!artifactWorkLineageHolder.current) throw new Error('Artifact lineage unavailable');
            return artifactWorkLineageHolder.current.resolve(input);
          },
        },
      };
      let workLifetime = new AbortController();
      const overview = ['0.1.0-beta.25', '0.1.0-beta.28'].includes(companionContract ?? '')
        ? new CompanionWorkOverview({
            ...workOptions,
            open: async (destination) => {
              if (destination.messageId)
                return (
                  homeHub?.openWork(
                    privateUserId,
                    () => resolveCompanionWorkPublication(workOptions, destination),
                    assertWorkCurrent,
                    workLifetime.signal,
                  ) ?? 'unconfirmed'
                );
              await openConversation(destination.threadId);
              return 'unconfirmed';
            },
          })
        : undefined;
      const work = overview
        ? {
            read: () => overview.read(),
            open: (entryRef: string) => overview.open(entryRef),
            reset: () => {
              workLifetime.abort('companion_binding_revoked');
              overview.reset();
              workLifetime = new AbortController();
            },
          }
        : undefined;
      return new CompanionHostBridge({
        ...(companionContract === '0.1.0-beta.29'
          ? {
              appAssist: new CompanionAppAssistOwner({
                store: redis ? conciergeConfigStoreShared : undefined,
                ownerUserId: privateUserId,
                timeZone: () => getCoCreatorConfig().timeZone,
                assertCurrent: assertWorkCurrent,
              }),
            }
          : {}),
        messages: messageStore,
        verifyConversationThread: (threadId) => conciergeThreadServiceShared.isCurrent(privateUserId, threadId),
        observeVoice: (observation) => liveCompanionSessions.observeVoice(privateUserId, observation),
        observeTextSubmission: (observation) => liveCompanionSessions.observeTextSubmission(privateUserId, observation),
        observePresentation: (observation, verifyHost) =>
          liveCompanionSessions.observePresentation(privateUserId, observation, verifyHost),
        app,
        ownerUserId: privateUserId,
        origin: `http://127.0.0.1:${PORT}`,
        assertCurrent: assertWorkCurrent,
        publicCompanionV2,
        ...(companionContract ? { companionContract } : {}),
        ...(disableCompanion ? { disableCompanion } : {}),
        ...decisions,
        openConversation,
      });
    },
    messageStore,
    lifecyclePresentation: (threadId, catId) => deliveryPresentation(threadId, { kind: 'cat', id: catId }),
    // P1.3: a v2 subscription's started names the message the invocation answers (origin, else A2A).
    lifecycleTriggerMessageId: async (invocationId) => {
      const record = await registry.getRecord(invocationId);
      return record?.originTriggerMessageId ?? record?.a2aTriggerMessageId;
    },
    deliveryPresentation,
    messagingStores,
    onMessagePublished: subscriptionDrainScheduler.schedule,
    taskStore,
    ...(redis ? { redis } : {}),
    invokeTrigger: createPluginConversationDelivery({ messageStore, queue: invocationQueue, router }),
    socketManager: { broadcastToRoom: (room, event, data) => socketManager?.broadcastToRoom(room, event, data) },
    threadStore,
    threadBindingStore: connectorBindingStore,
    threadOwnerUserId: privateUserId,
    onTaskDataChanged: (task) => {
      socketManager?.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', task);
      if (task.userId)
        socketManager?.emitToUser(task.userId, 'entrusted_work_projection_invalidated', { ownerUserId: task.userId });
    },
    members: {
      listCats: () =>
        Object.values(catRegistry.getAllConfigs()).map((cat) => ({
          catId: cat.id,
          displayName: cat.displayName,
          defaultModel: cat.defaultModel,
          ...(cat.nickname === undefined ? {} : { nickname: cat.nickname }),
          ...(cat.variantLabel === undefined ? {} : { variantLabel: cat.variantLabel }),
          ...(cat.roleDescription === undefined ? {} : { roleDescription: cat.roleDescription }),
          ...(cat.avatar === undefined ? {} : { avatar: cat.avatar }),
        })),
      publicAvatar: (value) =>
        publicParticipantAvatar(value, {
          avatars: join(findMonorepoRoot(), 'packages/web/public/avatars'),
          uploads: getDefaultUploadDir(process.env.UPLOAD_DIR),
        }),
      isCatAvailable,
    },
    threadDeepLinkUrl: createThreadDeepLinkUrl(frontendBaseUrl),
    threadProjections: {
      backlogStore,
      cats: {
        getAllCatIds: () => [...catRegistry.getAllIds()],
        getCatDisplayName: (id) => catRegistry.tryGet(id)?.config.displayName ?? id,
        getCatAliases: (id) => catRegistryMentionPatterns().get(id) ?? [],
        isCatAvailable,
        getRegisteredServices: () => agentRegistry.getAllEntries(),
      },
    },
  });
  trustedImagePathResolver = (hmrId) => pluginRuntime.mediaLedger.resolveTrustedBlobPath(hmrId);
  await app.register(mediaRoutes, { ledger: pluginRuntime.mediaLedger, ownerUserId: privateUserId });
  subscriptionDrainScheduler.attach(pluginRuntime.subscriptionDelivery);
  const { registerConciergeDesktopRoutes } = await import('./routes/concierge-desktop.js');
  registerConciergeDesktopRoutes(app, { ownerUserId: privateUserId, desktop: pluginRuntime.ownerDesktop });
  app.addHook('onClose', async () => pluginRuntime.shutdown('api_shutdown'));
  const { OFFICIAL_BUNDLED_MANIFESTS } = await import('./domains/plugin/official-catalog.js');
  const { createHostOfficialPluginCatalog } = await import('./domains/plugin/manager/host-official-catalog.js');
  const { GitMarketplaceRepository } = await import(
    './domains/plugin/manager/marketplace/git-marketplace-repository.js'
  );
  const { GitMarketplaceSources } = await import('./domains/plugin/manager/marketplace/git-marketplace-sources.js');
  const { validMarketplacePackages } = await import('./domains/plugin/manager/marketplace/git-marketplace-catalog.js');
  const marketplaceRepository = new GitMarketplaceRepository({
    cacheRoot: join(
      tmpdir(),
      `clowder-plugin-marketplaces-${createHash('sha256').update(pluginRuntime.paths.inventorySnapshotPath).digest('hex').slice(0, 16)}`,
    ),
  });
  const marketplaceSources = new GitMarketplaceSources({
    path: join(dirname(pluginRuntime.paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.marketplaceSources),
    repository: marketplaceRepository,
    validateCatalog: validMarketplacePackages,
    environment: process.env.PLUGIN_GIT_MARKETPLACE,
  });
  const pluginManagerCatalog = createHostOfficialPluginCatalog();
  const { FilesystemBuiltinPluginPackageMaterializer } = await import(
    './domains/plugin/manager/package-assets/builtin-package-materializer.js'
  );
  const { DotPluginStateProjection } = await import(
    './domains/cats/services/cloud-bridge/dot/DotPluginStateProjection.js'
  );
  const pluginManagerRuntime = createPluginManagerRuntimeComposition({
    additionalStateProjection: new DotPluginStateProjection(
      () => dotConnectionService,
      () => dotRoundTripVerified(),
    ),
    runtime: pluginRuntime,
    catalogProvider: pluginManagerCatalog,
    marketplaces: { sources: marketplaceSources, repository: marketplaceRepository },

    prepareDesktopComponent: async () => {
      await companionDesktopComponent.prepare();
    },
    catalogManifests: OFFICIAL_BUNDLED_MANIFESTS,
  });
  const { InstalledPluginOperations, pluginOperationRoutes } = await import(
    './domains/plugin/operations/plugin-operation-routes.js'
  );
  const { PersonalChromeSetup } = await import('./domains/plugin/manager/chrome-setup/personal-chrome-setup.js');
  const personalChromeSetup = new PersonalChromeSetup({
    inventory: pluginRuntime.inventoryStore,
    packages: pluginRuntime.packages,
    materializer: new FilesystemBuiltinPluginPackageMaterializer({ packagesRoot: pluginRuntime.paths.packagesRoot }),
    lifecycle: pluginRuntime.lifecycle,
    projectRoot: pluginRuntime.projectRoot,
  });
  const installedPluginOperations = new InstalledPluginOperations({
    personalChromeSetup,
    settingsInvocation: pluginRuntime.settingsInvocation,
    inventory: pluginRuntime.inventoryStore,
    configuration: pluginManagerRuntime.configuration,
    invocation: pluginRuntime.supervisor,
  });
  const { createCollectiveAccountabilitySource } = await import(
    './routes/companion-collective-accountability-source.js'
  );
  const collectiveSourceOperations = new InstalledPluginOperations({
    inventory: pluginRuntime.inventoryStore,
    configuration: pluginManagerRuntime.configuration,
    invocation: pluginRuntime.supervisor,
  });
  const { createInstalledCollectiveMaterialSource } = await import(
    './domains/plugin/host-surface/collective-material-source.js'
  );
  collectiveMaterialSourceHolder.current = createInstalledCollectiveMaterialSource(
    collectiveSourceOperations,
    privateUserId,
  );
  collectiveAttentionReader = createCollectiveAccountabilitySource(collectiveSourceOperations, privateUserId);
  const { createCollectiveWorkResultAttentionSource } = await import(
    './domains/plugin/host-surface/collective-work-result-attention.js'
  );
  const collectiveWorkResultAttentionSource = createCollectiveWorkResultAttentionSource(
    collectiveSourceOperations,
    privateUserId,
  );
  await app.register(pluginOperationRoutes, { operations: installedPluginOperations });
  const { ConnectorSettingsService, registerConnectorSettingsRoutes } = await import(
    './domains/plugin/manager/connector-settings.js'
  );
  registerConnectorSettingsRoutes(
    app,
    new ConnectorSettingsService({
      inventory: pluginRuntime.inventoryStore,
      ...(pluginRuntime.privateStorage ? { storage: pluginRuntime.privateStorage } : {}),
    }),
  );
  const { pluginNativeActionRoutes } = await import('./routes/plugin-native-action-routes.js');
  await app.register(pluginNativeActionRoutes, {
    actions: pluginRuntime.supervisor.nativeActions,
    registry,
    threadStore,
    sources: { messageStore },
  });
  const { prepareHostInitialPlugins } = await import('./domains/plugin/manager/initial-plugin-installation.js');
  let initialPlugins: Awaited<ReturnType<typeof prepareHostInitialPlugins>> | undefined;
  try {
    initialPlugins = await prepareHostInitialPlugins({
      runtime: pluginRuntime,
      managerRuntime: pluginManagerRuntime,
      catalog: pluginManagerCatalog,
      onFailure: (pluginId, error) => app.log.warn({ pluginId, err: error }, '[api] Initial plugin setup pending'),
    });
  } catch (error) {
    // Offline discovery must not prevent the Host from opening. The durable journal retries
    // unfinished entries on restart; completed entries (including user uninstalls) stay completed.
    app.log.warn({ err: error }, '[api] Initial plugin installation deferred until next startup');
  }
  // Released once app.listen resolves. A resumed desktop window's bridge calls
  // app.inject; before Fastify has booted that breaks the remaining app.register
  // calls (AVV_ERR_ROOT_PLG_BOOTED). Other plugins resume immediately.
  let releaseHostListening = () => {};
  const hostListening = new Promise<void>((resolve) => {
    releaseHostListening = resolve;
  });
  const { pluginManagerUploadRoutes, registerPluginManagerRoutes } = await import('./routes/plugin-manager-routes.js');
  const { registerPluginMarketplaceRoutes } = await import('./routes/plugin-marketplace-routes.js');
  const { registerAgentClientLibraryRoutes } = await import('./routes/agent-client-library-routes.js');
  registerAgentClientLibraryRoutes(app, {
    inventory: pluginRuntime.inventoryStore,
    packages: pluginRuntime.packages,
    registry: sessionImplementations,
    configuration: {
      readConfig: async (instanceId, key) => {
        const snapshot = await pluginRuntime.inventoryStore.snapshot();
        const instance = snapshot.instances.find((instance) => instance.pluginInstanceId === instanceId);
        if (!instance) return undefined;
        return (await pluginManagerRuntime.configuration.readActionInput(instance.pluginId))[key];
      },
    },
  });
  registerPluginMarketplaceRoutes(app, marketplaceSources);
  const { PluginManagerBindings } = await import('./domains/plugin/manager/plugin-manager-bindings.js');
  await app.register(async (managerApp) => {
    registerPluginManagerRoutes(managerApp, {
      manager: pluginManagerRuntime.manager,
      bindings: new PluginManagerBindings(connectorBindingStore, threadStore),
      contributions: pluginRuntime.supervisor,
      asset: pluginManagerRuntime.assets,
      documentation: pluginManagerRuntime.assets,
      callbackRegistry: registry,
    });
  });
  await app.register(pluginManagerUploadRoutes, { manager: pluginManagerRuntime.manager });
  const { createCollaborativeContentComposition } = await import(
    './domains/collaborative-content/runtime-composition.js'
  );
  const { registerCollaborativeContentRoutes } = await import('./routes/collaborative-content-routes.js');
  const { registerWorkspaceContentEditorRoutes } = await import('./routes/workspace-content-editor-routes.js');
  let projectCatGrants:
    | import('./domains/collaborative-content/workspace-review/project-message/cat-grants.js').ProjectMessageCatGrants
    | undefined;
  const projectMessageAuthority: import('./domains/collaborative-content/workspace-review/project-message/types.js').VideoProjectMessageAuthority =
    {
      messages: messageStore,
      authorizeSource: async ({ principal, threadId, messageId }) => {
        const thread = await threadStore.get(threadId);
        if (!thread || thread.createdBy !== principal.userId || thread.deletedAt)
          throw new Error('Project source access denied');
        if (messageId) {
          const message = await messageStore.getById(messageId);
          if (!message || message.userId !== principal.userId || message.threadId !== threadId)
            throw new Error('Project source access denied');
        }
      },
    };
  const collaborativeContent = createCollaborativeContentComposition({
    dataDir: process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    ownerUserId: privateUserId,
    plugins: pluginRuntime,
    authorizeVideoProjectCat: async (input) => {
      if (!projectCatGrants) throw new Error('Video project source authority unavailable');
      await projectCatGrants.authorize(input);
    },
    authorizeVideoProjectSelfReviewSource: async (input) => {
      if (!projectCatGrants) throw new Error('Video project source authority unavailable');
      await projectCatGrants.authorize({ ...input, permission: 'write' });
      const witness = await projectCatGrants.sourceWitness(input.principal, input.contentRef);
      return {
        refs: [`message:${witness.sourceMessageId}@${witness.sourceMessageRevision}`, `thread:${witness.threadId}`],
      };
    },
  });
  const { videoProjectRoutes } = await import('./routes/video-project-routes.js');
  await app.register(videoProjectRoutes, {
    projects: collaborativeContent.projects,
    screenings: collaborativeContent.screenings,
    mediaSource: collaborativeContent.projectMediaSource,
  });
  namedCatContentHolder.current = collaborativeContent.namedCats;
  registerCollaborativeContentRoutes(app, { ...collaborativeContent, ownerUserId: privateUserId });
  registerWorkspaceContentEditorRoutes(app, { workspace: collaborativeContent.workspace, ownerUserId: privateUserId });
  const { createWorkspaceContentReviewComposition } = await import(
    './domains/collaborative-content/workspace-review/composition.js'
  );
  const { registerWorkspaceContentReviewRoutes } = await import('./routes/workspace-content-review-routes.js');
  const workspaceContentReviews = createWorkspaceContentReviewComposition({
    dataDir: process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    ownerUserId: privateUserId,
  });
  app.addHook('onClose', async () => workspaceContentReviews.store.close());
  registerWorkspaceContentReviewRoutes(app, {
    reviews: workspaceContentReviews.reviews,
    fileQuotes: { source: workspaceContentReviews.source, messages: messageStore, threads: threadStore },
    changed: (ownerUserId, reviewId) => socketManager?.emitToUser(ownerUserId, 'artifact_review_changed', { reviewId }),
  });
  const { DotConnectionStore } = await import('./domains/cats/services/cloud-bridge/dot/DotConnectionStore.js');
  const { ensureDotIdentity } = await import('./domains/cats/services/cloud-bridge/dot/dot-identity.js');
  const { registerDotConnectionRoutes } = await import('./routes/chatgpt-dot-connection-routes.js');
  const { createDotWebhookSender } = await import('./domains/cats/services/cloud-bridge/dot/dot-webhook.js');
  const dotWebhookSender = createDotWebhookSender(process.env.CAT_CAFE_DOT_WEBHOOK_PROXY_URL);
  dotConnectionService = new DotConnectionService({
    sendWebhook: dotWebhookSender,
    store: new DotConnectionStore(resolve(pluginHostRoot(pluginProjectRoot), PLUGIN_HOST_ENTRIES.dotConnection)),
    keys: agentKeyRegistry,
    ensureIdentity: async () => {
      if (ensureDotIdentity(pluginProjectRoot)) {
        await syncAgentRegistry(reconcileCatRegistry(pluginProjectRoot, new Set()));
        await configEventBus.emitChangeAsync({
          source: 'cat-config',
          scope: 'domain',
          changedKeys: ['gpt-dot'],
          changeSetId: `dot-identity:${Date.now()}`,
          timestamp: Date.now(),
        });
      }
    },
    authority: async () => {
      const inventory = await pluginRuntime.inventoryStore.snapshot();
      const instance = inventory.instances.find(
        (candidate) => candidate.pluginId === 'official.chatgpt-dot' && candidate.lifecycleState === 'installed',
      );
      return instance ? { ownerUserId: privateUserId, pluginInstanceId: instance.pluginInstanceId } : null;
    },
  });
  registerDotConnectionRoutes(app, {
    connection: dotConnectionService,
    publicBaseUrl: () => process.env.CAT_CAFE_REMOTE_PUBLIC_BASE_URL,
  });
  const { DotDispatchStore } = await import('./domains/cats/services/cloud-bridge/dot/DotDispatchStore.js');
  const { DotEventsBridge } = await import('./domains/cats/services/cloud-bridge/dot/DotEventsBridge.js');
  const { DotReturnService } = await import('./domains/cats/services/cloud-bridge/dot/DotReturnService.js');
  const { DotImageService } = await import('./domains/cats/services/cloud-bridge/dot/DotImageService.js');
  const dotDispatches = new DotDispatchStore(
    resolve(pluginHostRoot(pluginProjectRoot), PLUGIN_HOST_ENTRIES.dotDispatches),
  );
  dotRoundTripVerified = async () => {
    const state = await dotConnectionService?.current();
    if (!state || state.testEventIds.length !== 2) return false;
    const records = await Promise.all(state.testEventIds.map((id) => dotDispatches.read(id)));
    return records.every(
      (record) =>
        record?.attemptId === state.attemptId &&
        record.agentKeyId === state.agentKeyId &&
        record.connectionTest &&
        !!record.sourceReadAt &&
        !!record.replyMessageId,
    );
  };
  const dotEnabled = async () =>
    (await pluginRuntime.inventoryStore.snapshot()).instances.some(
      (instance) =>
        instance.pluginId === 'official.chatgpt-dot' &&
        instance.lifecycleState === 'installed' &&
        instance.activationState === 'enabled',
    );
  const { DotAskService } = await import('./domains/cats/services/cloud-bridge/dot/DotAskService.js');
  dotAskService = new DotAskService({
    connection: dotConnectionService,
    messages: messageStore,
    threads: threadStore,
    enabled: dotEnabled,
    post: async (secret, payload) => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': secret },
        payload,
      });
      const body = result.json() as { messageId?: string; kind?: string };
      if (result.statusCode !== 200 || !body.messageId)
        throw new Error(
          body.kind === 'dot_ask_idempotency_conflict' || body.kind === 'dot_ask_delivery_pending'
            ? body.kind
            : 'dot_ask_not_persisted',
        );
      return body;
    },
  });
  dotEventsBridge = new DotEventsBridge({
    sendWebhook: dotWebhookSender,
    connection: dotConnectionService,
    dispatches: dotDispatches,
    messageStore,
    threadStore,
    enabled: dotEnabled,
  });
  dotReturnService = new DotReturnService({
    connection: dotConnectionService,
    dispatches: dotDispatches,
    messages: messageStore,
    threads: threadStore,
    enabled: dotEnabled,
    postReply: async ({ secret, eventId, threadId, sourceMessageId, content }) => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': secret, 'x-cat-cafe-dot-event-id': eventId },
        payload: { threadId, replyTo: sourceMessageId, content },
      });
      const body = result.json() as { messageId?: string };
      if (result.statusCode !== 200 || !body.messageId) throw new Error('dot_reply_not_persisted');
      return { messageId: body.messageId };
    },
  });
  const dotImages = new DotImageService({
    directory: resolve(pluginHostRoot(pluginProjectRoot), PLUGIN_HOST_ENTRIES.dotImages),
    returns: dotReturnService,
    connection: dotConnectionService,
    dispatches: dotDispatches,
    messages: messageStore,
    threads: threadStore,
    emit: ({ threadId, messageId, block }) => {
      socketManager?.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: createCatId('gpt-dot'),
          content: JSON.stringify({ type: 'rich_block', block, messageId }),
          invocationId: messageId,
          timestamp: Date.now(),
        },
        threadId,
      );
    },
  });
  const { registerDotMcpRoutes } = await import('./routes/chatgpt-dot-mcp-routes.js');
  const { registerDotImageRoutes } = await import('./routes/chatgpt-dot-image-routes.js');
  registerDotMcpRoutes(app, {
    connection: dotConnectionService,
    returns: dotReturnService,
    ask: (secret, input) => dotAskService!.ask(secret, input),
    publishImage: (secret, input) => dotImages.publish(secret, input),
  });
  registerDotImageRoutes(app, dotImages);
  const { registerDotTestRoutes } = await import('./routes/chatgpt-dot-test-routes.js');
  const { DotConnectionTestService } = await import(
    './domains/cats/services/cloud-bridge/dot/DotConnectionTestService.js'
  );
  const dotConnectionTests = new DotConnectionTestService({
    connection: dotConnectionService,
    dispatches: dotDispatches,
    bridge: dotEventsBridge,
    messages: messageStore,
    threads: threadStore,
    grants: cloudReturnGrantStore,
    projectPath: pluginProjectRoot,
  });
  registerDotTestRoutes(app, {
    connection: dotConnectionService,
    dispatches: dotDispatches,
    threads: threadStore,
    startTest: (ownerUserId) => dotConnectionTests.run(ownerUserId),
  });
  // Dot resume consumes its persisted connection and source proofs, composed above.
  const externalPluginRecovery = await pluginRuntime.recoverAfterRestart({ desktopWindowsAfter: hostListening });
  app.log.info(
    `[api] K-2 plugin runtime recovered ` +
      `(sessions=${externalPluginRecovery.brokerSessions}, instances=${externalPluginRecovery.inventoryInstances}, ` +
      `resumeRequested=${externalPluginRecovery.resumeRequested}; ` +
      `live=${externalPluginRecovery.resumeRequested > 0 ? 'reconciling' : 'dormant'})`,
  );
  const { storedAttachmentMediaRoutes } = await import('./routes/stored-attachment-media.js');
  await app.register(storedAttachmentMediaRoutes, {
    mediaDir: getDefaultConnectorMediaDir(process.env.CONNECTOR_MEDIA_DIR),
  });
  const { pluginWebhookForwardingRoutes } = await import('./routes/plugin/plugin-webhook-forwarding-routes.js');
  await app.register(pluginWebhookForwardingRoutes, { webhooks: pluginRuntime.supervisor });

  // F246/F313: one registry and one renderer projection. The F266 writer stays
  // fenced until an owner-backed resolver/dispatcher and a v1_active epoch are
  // supplied by an explicit production migration.
  const f266ApprovalAdapter = new F266ApprovalAdapter(reevalClosureEventLog);
  const f266EpochAuthority = redis ? new RedisApprovalLifecycleEpochAuthority(redis) : undefined;
  if (
    evolutionProgramService &&
    reevalClosureEventLog &&
    requestReviewOwnerLedger &&
    requestReviewOwnerReceipts &&
    actionSuccessorLeaseStore &&
    f266CaseActionResolver &&
    requestReviewLineage
  ) {
    const ownerTruthOptions = {
      programReader: evolutionProgramService,
      versionReader: requestReviewVersionReader,
    };
    const requestReviewDispatcher = new RequestReviewCanonicalRepairDispatcher({
      eventLog: reevalClosureEventLog,
      ledger: requestReviewOwnerLedger,
      taskStore,
      leaseStore: actionSuccessorLeaseStore,
      lineageBindingResolver: requestReviewLineage,
      resolveCurrentSnapshot: () => resolveRequestReviewCurrentOwnerSnapshot(ownerTruthOptions),
    });
    requestReviewOwnerActions = createRequestReviewOwnerActions({
      resolveCurrentSnapshot: () => resolveRequestReviewCurrentOwnerSnapshot(ownerTruthOptions),
      dispatcher: requestReviewDispatcher,
      versionVerifier: createRequestReviewCommitVersionVerifier(requestReviewOwnerPort),
      receipts: requestReviewOwnerReceipts,
    });
    evalRepairOwnerRuntimeRegistration.registerBindingProvider(
      createRequestReviewEvalRepairOwnerBindingProvider({
        ownerUserId: privateUserId,
        ...ownerTruthOptions,
        invocationRegistry: registry,
        lineageBindingResolver: requestReviewLineage,
        canonicalRepairDispatcher: requestReviewDispatcher,
        interventionReceiptOwner: {
          resolve: requestReviewOwnerReceipts.resolveIntervention.bind(requestReviewOwnerReceipts),
        },
        freshOutcomeOwner: {
          resolve: requestReviewOwnerReceipts.resolveFreshOutcome.bind(requestReviewOwnerReceipts),
        },
        decisionOwner: createRequestReviewDecisionOwner({
          eventLog: reevalClosureEventLog,
          ledger: requestReviewOwnerLedger,
          lineageBindingResolver: requestReviewLineage,
        }),
      }),
    );
  }
  const f266OwnerRuntime = await createEvalRepairOwnerRuntime({
    lifecycleVersion: 1,
    loaderVersion: 1,
    routeVersion: 1,
    materializerVersion: 1,
    ...(reevalClosureEventLog ? { eventLog: reevalClosureEventLog } : {}),
    approvalIngress,
    approvalAdapter: f266ApprovalAdapter,
    ...(f266EpochAuthority ? { epochAuthority: f266EpochAuthority } : {}),
    ...(f266CaseActionResolver
      ? { caseActionResolver: f266CaseActionResolver.resolve.bind(f266CaseActionResolver) }
      : {}),
    releaseTruth: evalReleaseTruth,
    registration: evalRepairOwnerRuntimeRegistration,
  });
  const f266Cutover = f266OwnerRuntime.status === 'active' ? f266OwnerRuntime.cutover : f266OwnerRuntime;
  if (f266OwnerRuntime.status === 'dormant') {
    app.log.info(
      { missing: f266OwnerRuntime.missing },
      '[api] F313 Phase D: eval repair owner runtime remains fail-closed',
    );
  }

  // F246: Approval Hub — unified operator approval center.
  const approvalProducerRegistry = new ApprovalProducerRegistry({
    F128: bindLegacyApprovalProducer(new F128ApprovalAdapter(proposalStore, (id) => threadStore.get(id))),
    F139: bindLegacyApprovalProducer(new F139ApprovalAdapter(scheduleMutationProposalStore)),
    F193: bindLegacyApprovalProducer(new F193ApprovalAdapter(dispatchProposalStore)),
    F221: bindLegacyApprovalProducer(new F221ApprovalAdapter(tasteProposalStore)),
    F225: bindLegacyApprovalProducer(new F225ApprovalAdapter(handoffProposalStore)),
    F231: bindLegacyApprovalProducer(new F231ApprovalAdapter(profileUpdateProposalStore)),
    F276: bindLegacyApprovalProducer(new F276ApprovalAdapter(personMemoryStore)),

    F306: bindLegacyApprovalProducer(new F306ApprovalAdapter(runtimeInteractionRuntime.store)),
    F321: bindLegacyApprovalProducer(new F321ApprovalAdapter(eventMemoryCorrectionProposalStore)),
    F260: bindLegacyApprovalProducer(
      new F260ApprovalAdapter(
        entityProposalStore,
        (proposal) => {
          if (!memoryServices.evidenceStore.inspectEntityConflict) {
            throw new Error('F260: evidenceStore.inspectEntityConflict not available — Hub projection blocked');
          }
          return memoryServices.evidenceStore.inspectEntityConflict(
            buildEntityRecord(proposal, proposal.ownerUserId),
            proposal.ownerUserId,
          );
        },
        (proposal) =>
          memoryServices.evidenceStore.getEntityProposalEffectProof?.(
            proposal.entityId,
            proposal.proposalId,
            proposal.ownerUserId,
          ) ?? null,
      ),
    ),
    F266: bindV1ApprovalProducer(f266ApprovalAdapter),
  });
  approvalDecisionReceipts = new ApprovalDecisionReceiptService({
    registry: approvalProducerRegistry,
    messageStore,
    invocationTracker,
    outbox: new ApprovalDecisionReceiptOutbox(schedulerDb),
    logger: app.log,
  });
  const { createArtifactReviewIntegration } = await import('./domains/growing/artifact-review-composition.js');
  const { createProgramContentMediaPort } = await import(
    './infrastructure/capability-evolution/read-model/program-content-media-port.js'
  );
  const { registerArtifactReviewRoutes } = await import('./routes/artifact-review-routes.js');
  const { registerCallbackArtifactReviewRoutes } = await import('./routes/callback-artifact-review-routes.js');
  const artifactReview = createArtifactReviewIntegration({
    dataDir: process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    uploadDir: getDefaultUploadDir(process.env.UPLOAD_DIR),
    readPrivateMessageImage: async (id, principal) => (await dotImages.read(id, principal.userId)).bytes,
    owner: collaborativeContent.owner,
    projects: collaborativeContent.projects,
    screenings: collaborativeContent.screenings,
    projectMessageAuthority,
    publications: preparedArtifactReader,
    workspace: workspaceContentReviews.source,
    ...(evolutionProgramService
      ? {
          evolution: createProgramContentMediaPort({
            service: evolutionProgramService,
            adapterRegistry: evolutionProgramAdapterRegistry,
          }),
        }
      : {}),
    ...(routingContextRuntime ? { routing: routingContextRuntime.dispatchPreflight } : {}),
    tasks: taskStore,
    threads: threadStore,
    messages: messageStore,
    delivery: persistedQueueDelivery,
    emit: (userId, event, data) => socketManager?.emitToUser(userId, event, data),
    onError: (error) => app.log.warn({ err: error }, '[artifact-review] recovery remains pending'),
  });
  const { createCollectiveArtifactOwner } = await import(
    './domains/collaborative-content/collective-artifact/owner-router.js'
  );
  const collectiveArtifactOwner = createCollectiveArtifactOwner({
    transcribeAudio: (
      await import('./infrastructure/connectors/media/CollectiveSttProvider.js')
    ).createConfiguredCollectiveTranscriber(),
    stickerDirectories: {
      memory: join(findMonorepoRoot(dirname(fileURLToPath(import.meta.url))), 'packages/web/public/f321/stickers'),
      collaboration: join(
        findMonorepoRoot(dirname(fileURLToPath(import.meta.url))),
        'docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration',
      ),
    },
    owner: collaborativeContent.owner,
    media: artifactReview.media,
    reviews: workspaceContentReviews.store,
    modifications: artifactReview.store,
    ownerUserId: privateUserId,
    custodyDataDir: process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    onError: (error) =>
      app.log.debug(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'Collective owner operation refused',
      ),
  });
  collectiveArtifactOwnerHolder.retainedMedia = collectiveArtifactOwner.publishedMedia;
  collectiveArtifactOwnerHolder.current = collectiveArtifactOwner.port;
  artifactWorkLineageHolder.current = artifactReview.globalArtifactWorkLineage;
  if (artifactReview.projectMessages) {
    const { createProjectMessageProducer } = await import(
      './domains/collaborative-content/workspace-review/project-message/producer.js'
    );
    projectMessageProducer = createProjectMessageProducer({
      importer: artifactReview.projectMessages,
      changed: (userId, reviewId) => socketManager?.emitToUser(userId, 'artifact_review_changed', { reviewId }),
    });
    const priorProjectAppend = appendListener;
    appendListener = (message) => {
      priorProjectAppend?.(message);
      void projectMessageProducer?.(message).catch((error) =>
        app.log.warn({ err: error }, 'Project opinion remains recoverable from source message'),
      );
    };
    const oldTimeline = messageStore.onTimelineChanged;
    messageStore.onTimelineChanged = (message) => {
      oldTimeline?.(message);
      void projectMessageProducer?.(message).catch((error) =>
        app.log.warn({ err: error }, 'Project opinion remains recoverable from source message'),
      );
    };
    const { registerVideoProjectReviewRoutes } = await import('./routes/video-project-review-routes.js');
    registerVideoProjectReviewRoutes(app, artifactReview.projectMessages);
  }
  app.addHook('onClose', async () => artifactReview.store.close());
  taskRunnerV2.register(artifactReview.recoverySpec);
  await app.register(async (scope) => registerArtifactReviewRoutes(scope, artifactReview));
  const { registerPublishedContentRoutes } = await import('./routes/published-content-routes.js');
  registerPublishedContentRoutes(app, { media: artifactReview.media });
  const { LivingWorkService } = await import('./domains/collaborative-content/works/service.js');
  const { WorkCatalogue } = await import('./domains/collaborative-content/works/catalogue.js');
  const { createWorkAuthorizer, workMediaPrincipal } = await import('./domains/collaborative-content/works/access.js');
  const { createWorkWorkspaceSource } = await import('./domains/collaborative-content/works/workspace-source.js');
  const { registerLivingWorkRoutes } = await import('./routes/living-work-routes.js');
  const { WorkReviewResponseService } = await import('./domains/collaborative-content/works/review-response.js');
  const { createWorkResponseAuthority } = await import(
    './domains/collaborative-content/works/review-response-authority.js'
  );
  const { withContentTask: withWorkResponseTask } = await import(
    './domains/video-studio/content-owner/published-media-access.js'
  );
  const workResponses = new WorkReviewResponseService({
    owner: collaborativeContent.owner,
    store: artifactReview.store,
    onCommitted: async (reviewId) => {
      await artifactReview.reviews.projectCommitted(reviewId);
      await artifactReview.changed(privateUserId, reviewId);
    },
    authorize: createWorkResponseAuthority({
      store: artifactReview.store,
      media: artifactReview.media,
      messages: messageStore,
    }),
    readAsset: (review, revision, principal) =>
      artifactReview.media.read(
        review.contentRef,
        revision,
        withWorkResponseTask(workMediaPrincipal(principal), review.task.taskId),
      ),
  });
  artifactReview.reviews.setWorkResponseRecovery((review, principal) =>
    workResponses.recover(review, {
      ...principal,
      threadId: principal.threadId ?? review.task.threadId,
    }),
  );
  const livingWorks = new LivingWorkService({
    changed: (ownerUserId) =>
      socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId }),
    responses: workResponses,
    owner: collaborativeContent.owner,
    versions: artifactReview.store.works,
    source: createWorkWorkspaceSource(workspaceContentReviews.source),
    authorize: createWorkAuthorizer({
      ownerUserId: privateUserId,
      access: artifactReview.media.access,
      invocation: (id) => registry.peekRecord(id),
    }),
  });
  const { WorkVideoContextService } = await import('./domains/collaborative-content/works/video-context.js');
  const { createWorkContextSource } = await import('./domains/collaborative-content/works/context-source.js');
  const { createWorkSourceBindingVerifier } = await import('./domains/collaborative-content/works/source-binding.js');
  const workContexts = new WorkVideoContextService({
    store: artifactReview.store.works.contexts,
    contextSource: createWorkContextSource(workspaceContentReviews.source),
    verifyBinding: createWorkSourceBindingVerifier({
      projects: collaborativeContent.projects,
      screenings: collaborativeContent.screenings,
      reviews: artifactReview.projectReviews,
      workDigest: async (reference, principal) =>
        (await artifactReview.media.read(reference.contentRef, reference.ownerRevision, workMediaPrincipal(principal)))
          .blobDigest,
    }),
    authorize: (reference, principal, permission) =>
      livingWorks.authorizeVersion(
        reference,
        principal.actor.kind === 'human' && !principal.threadId
          ? {
              ...principal,
              threadId:
                artifactReview.store.works.get(principal.userId, reference.contentRef, reference.ownerRevision)
                  ?.threadId ?? '',
            }
          : principal,
        permission,
      ),
    verifyAssets: (context, principal, retained) => assetCanonService!.verifySelections(context, principal, retained),
    assertAssetSelections: (context, owner, retained) => assetCanonService!.assertSelections(context, owner, retained),
    media: async (reference, principal) => {
      const asset = await artifactReview.media.read(
        reference.contentRef,
        reference.ownerRevision,
        workMediaPrincipal(principal),
      );
      if (asset.media.kind !== 'video') throw new Error('Video context requires video bytes');
      return asset.media;
    },
  });
  artifactReview.media.setAnchorEvidenceVerifier(async (reference, anchor, principal) => {
    const { scope } = await artifactReview.media.origin(reference.contentRef, principal);
    if (!scope.threadId) throw new Error('Story evidence requires its original work thread');
    await workContexts.verifyStory(reference, anchor, {
      ...principal,
      threadId: principal.threadId ?? scope.threadId,
    });
  });
  const { registerWorkVideoAssetRoutes } = await import('./routes/work-video-asset-routes.js');
  const { VideoProjectAssetIndex } = await import('./domains/video-studio/project/asset-index.js');
  const { resolveWorkspaceContentRoot } = await import('./domains/workspace/workspace-content-source-factory.js');
  const canonAssetIndex = new VideoProjectAssetIndex({ resolveRoot: resolveWorkspaceContentRoot });
  const { MediaOwnerError } = await import('./domains/video-studio/content-owner/media-errors.js');
  const { AssetCanonService } = await import('./domains/collaborative-content/asset-canon/service.js');
  const { MemberCanonService } = await import('./domains/collaborative-content/asset-canon/member-service.js');
  const { getResolvedCats } = await import('./config/resolved-cats.js');
  const producerAuthorizer = createWorkAuthorizer({
    ownerUserId: privateUserId,
    access: artifactReview.media.access,
    invocation: (id) => registry.peekRecord(id),
  });
  assetCanonService = new AssetCanonService({
    store: artifactReview.store.works.assets,
    contextStore: artifactReview.store.works.contexts,
    contexts: workContexts,
    authorize: async (principal) => {
      if (principal.userId !== privateUserId) throw new MediaOwnerError('access_denied');
      if (principal.actor.kind === 'human') {
        if (principal.actor.actorId !== privateUserId || principal.invocationId)
          throw new MediaOwnerError('access_denied');
      } else await producerAuthorizer({ principal, permission: 'read' });
    },
    authorizeWork: (reference, principal, permission) =>
      livingWorks.authorizeVersion(
        reference,
        principal.actor.kind === 'human' && !principal.threadId
          ? {
              ...principal,
              threadId:
                artifactReview.store.works.get(principal.userId, reference.contentRef, reference.ownerRevision)
                  ?.threadId ?? '',
            }
          : principal,
        permission,
      ),
    authorizeRoot: async (version) => {
      try {
        await resolveWorkspaceContentRoot(version.locator.rootId);
      } catch {
        throw new MediaOwnerError('access_denied');
      }
    },
    inspect: async (version, principal) => {
      const locator = await workspaceContentReviews.source.resolveFileLocator({
        principal: { userId: principal.userId },
        locator: { worktreeId: version.locator.rootId, path: version.locator.path },
      });
      return canonAssetIndex.inspect({ kind: 'workspace', rootId: locator.worktreeId, path: locator.path });
    },
    assertMember: async (catId, principal) => {
      if (
        principal.actor.kind !== 'human' ||
        principal.invocationId ||
        principal.userId !== privateUserId ||
        !getResolvedCats(resolveActiveProjectRoot())[catId]
      )
        throw new MediaOwnerError('access_denied');
    },
  });
  memberCanonService = new MemberCanonService(assetCanonService, privateUserId);
  await registerLivingWorkRoutes(app, {
    service: livingWorks,
    registry,
    contexts: workContexts,
    assets: assetCanonService,
  });
  registerWorkVideoAssetRoutes(app, { contexts: workContexts, assets: canonAssetIndex });
  const { registerAssetCanonRoutes } = await import('./routes/asset-canon-routes.js');
  registerAssetCanonRoutes(app, assetCanonService, canonAssetIndex);
  const { registerMemberCanonRoutes } = await import('./routes/member-canon-routes.js');
  registerMemberCanonRoutes(app, {
    members: memberCanonService,
    assets: canonAssetIndex,
    source: workspaceContentReviews.source,
  });
  artifactWorkLineageHolder.independent = new WorkCatalogue(livingWorks, artifactReview.store.works.contexts);
  if (!artifactReview.ledgers) throw new Error('F309 publication ledger requires the F063 source owner');
  registerWorkspaceContentReviewRoutes(app, {
    reviews: artifactReview.ledgers,
    namespace: 'publication',
    changed: (ownerUserId, reviewId) => socketManager?.emitToUser(ownerUserId, 'artifact_review_changed', { reviewId }),
  });
  const { createContentModificationIntegration } = await import(
    './domains/collaborative-content/modification/composition.js'
  );
  const { registerContentModificationRoutes } = await import('./routes/content-modification-routes.js');
  const modifications = createContentModificationIntegration({
    dataDir: process.env.CAT_CAFE_DATA_DIR ?? join(resolveActiveProjectRoot(), '.cat-cafe'),
    source: workspaceContentReviews.source,
    files: workspaceContentReviews.reviews,
    artifacts: artifactReview,
    project: { projects: collaborativeContent.projects, authority: projectMessageAuthority },
    tasks: taskStore,
    messages: messageStore,
    turnExecutions: turnExecutionStore,
    queue: invocationQueue,
    delivery: persistedQueueDelivery,
    sourceChanged: (ownerUserId, threadId, messageId) =>
      socketManager?.emitToUser(ownerUserId, 'content_modification_source_saved', { threadId, messageId }),
    receiptChanged: (ownerUserId, threadId, messageId) =>
      socketManager?.emitToUser(ownerUserId, 'content_modification_source_saved', { threadId, messageId }),
    changed: (ownerUserId) =>
      socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId }),
    onError: (error) => app.log.warn({ err: error }, '[content-modification] request remains pending'),
  });
  acceptedWorkspaceArtifactsHolder.current = modifications.workspaceArtifacts;
  contentControlReceipts = modifications.runtimeControls;
  if (modifications.projectTakeover && artifactReview.projectReviews) {
    const { ProjectMessageCatGrants } = await import(
      './domains/collaborative-content/workspace-review/project-message/cat-grants.js'
    );
    projectCatGrants = new ProjectMessageCatGrants({
      turns: turnExecutionStore,
      authority: projectMessageAuthority,
      ledgers: artifactReview.store.ledgers,
      takeover: modifications.projectTakeover,
    });
    const { registerCallbackVideoProjectCommandRoutes } = await import(
      './routes/callback-video-project-command-routes.js'
    );
    await registerCallbackVideoProjectCommandRoutes(app, {
      projects: collaborativeContent.projects,
      reviews: artifactReview.projectReviews,
      selfReviews: collaborativeContent.selfReviews,
      takeover: modifications.projectTakeover,
      threads: threadStore,
      registry,
      changed: (ownerUserId, contentRef) =>
        socketManager?.emitToUser(ownerUserId, 'artifact_review_changed', { contentRef }),
    });
  }
  registerContentModificationRoutes(app, modifications);
  await registerCallbackArtifactReviewRoutes(app, {
    ...artifactReview,
    sourceDiscussions: modifications.sourceDiscussions,
    threads: threadStore,
    registry,
    ...(agentKeyRegistry ? { agentKeyRegistry } : {}),
  });
  const { registerCallbackContentModificationRoutes } = await import(
    './routes/callback-content-modification-routes.js'
  );
  await registerCallbackContentModificationRoutes(app, {
    text: modifications.text,
    receipts: modifications.receipts,
    requests: modifications.requests,
    sourceDiscussions: modifications.sourceDiscussions,
    threads: threadStore,
    registry,
    ...(agentKeyRegistry ? { agentKeyRegistry } : {}),
    changed: (ownerUserId, requestId) => {
      socketManager?.emitToUser(ownerUserId, 'content_modification_changed', { requestId });
      socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId });
    },
  });
  taskRunnerV2.register(modifications.recoverySpec);
  app.addHook('onClose', async () => modifications.writer.close());
  const needsMeProducerCatalog = new NeedsMeProducerCatalog(
    [
      new F246NeedsMeProducerAdapter(approvalProducerRegistry),
      new F306NeedsMeProducerAdapter(runtimeInteractionRuntime.store),
      artifactReview.producer,
      new F290CollectiveWorkResultPluginAdapter(collectiveWorkResultAttentionSource),
    ],
    ['f246.approval', 'f306.runtime_interaction', 'f309.content_review', 'f290.collective_work_result'],
  );
  const { DevelopmentReturnService } = await import(
    './infrastructure/scheduler/development-return/DevelopmentReturnService.js'
  );
  const { readRecordedRequestReview } = await import(
    './infrastructure/capability-evolution/adapters/request-review/request-review-provenance.js'
  );
  const { registerCallbackDevelopmentReturnRoutes } = await import('./routes/callback-development-return-routes.js');
  const developmentReturns = new DevelopmentReturnService({
    emit: (userId, event, data) => socketManager?.emitToUser(userId, event, data),
    delivery: new PersistedQueueDelivery({
      messages: messageStore,
      queue: invocationQueue,
      progress: (entry, targetCatId) => queueProcessor.progressOwnedCarrier(entry, targetCatId),
    }),
    definitions: dynamicTaskStore,
    runner: taskRunnerV2,
    tasks: taskStore,
    threads: threadStore,
    messages: messageStore,
    proposals: proposalStore,
    ...(actionSuccessorLeaseStore ? { actionSuccessors: actionSuccessorLeaseStore } : {}),
    ...(requestReviewOwnerLedger
      ? {
          readReviewProvenance: (query) => readRecordedRequestReview(requestReviewOwnerLedger, messageStore, query),
        }
      : {}),
  });
  templateRegistry.register(developmentReturns.template);
  const { createAlphaBrowserTemplate, supportsAlphaBrowserVerification } = await import(
    './infrastructure/scheduler/templates/alpha-browser.js'
  );
  if (supportsAlphaBrowserVerification(repoRoot))
    templateRegistry.register(
      createAlphaBrowserTemplate({
        repoRoot,
        ownerUserId: privateUserId,
        tasks: taskStore,
        resolveCat: (mention) => {
          const candidates = Object.entries(catRegistry.getAllConfigs()).filter(
            ([id, config]) =>
              id === mention ||
              config.mentionPatterns.some((pattern) => pattern.toLowerCase() === `@${mention.toLowerCase()}`),
          );
          return candidates.length === 1 ? (candidates[0]?.[0] ?? null) : null;
        },
      }),
    );
  await registerCallbackDevelopmentReturnRoutes(app, { registry, service: developmentReturns });
  const { createProducerAttentionReevaluationTemplate } = await import(
    './domains/growing/ProducerAttentionReevaluationTaskSpec.js'
  );
  templateRegistry.register(
    createProducerAttentionReevaluationTemplate({
      tasks: taskStore,
      producerCatalog: needsMeProducerCatalog,
      invalidateProjection: (ownerUserId) => {
        socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId });
      },
    }),
  );
  const { CustodyOpportunityCohortStore } = await import('./domains/growing/CustodyOpportunityCohortStore.js');
  const { CustodyOpportunityRuntime, custodyRecognitionPolicyVersion, startCustodyOpportunityObservation } =
    await import('./domains/growing/CustodyOpportunityRuntime.js');
  const { registerCustodyOpportunityRoutes } = await import('./routes/custody-opportunity-routes.js');
  let custodyOpportunityRuntime: InstanceType<typeof CustodyOpportunityRuntime> | null = null;
  try {
    custodyOpportunityRuntime = new CustodyOpportunityRuntime({
      cohorts: new CustodyOpportunityCohortStore(memoryServices.store.getDb()),
      messages: messageStore,
      tasks: taskStore,
      policyVersion: await custodyRecognitionPolicyVersion(repoRoot),
    });
    custodyOpportunityObservation = startCustodyOpportunityObservation({
      runtime: custodyOpportunityRuntime,
      ownerUserId: privateUserId,
      onError: (error) => app.log.warn({ err: error }, '[F310] Recognition evidence read failed; no utility verdict'),
      onReviewDue: (snapshotRef) =>
        app.log.info({ snapshotRef }, '[F310] Recognition cohort needs independent calibration'),
    });
  } catch (error) {
    custodyOpportunityRuntime = null;
    app.log.warn({ err: error }, '[F310] Recognition evidence unavailable; Task lifecycle remains independent');
  }
  app.addHook('onClose', async () => {
    await custodyOpportunityObservation?.close();
  });
  registerCustodyOpportunityRoutes(app, custodyOpportunityRuntime);
  const entrustedWorkTaskExecution = new EntrustedWorkTaskExecutionService({
    ...(actionSuccessorLeaseStore ? { leaseStore: actionSuccessorLeaseStore } : {}),
    invocationRecords: invocationRecordStore,
    turnExecutions: turnExecutionStore,
    tracker: invocationTracker,
    ...(taskApprovedDelegateProvider ? { taskApprovedDelegateProvider } : {}),
  });
  const invalidateEntrustedWorkProjection = (ownerUserId: string) =>
    socketManager?.emitToUser(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId });
  const entrustedWorkHumanTerminal = new EntrustedWorkHumanTerminalService({
    tasks: taskStore,
    lifecycle: new EntrustedWorkLifecycleService(taskStore, {
      artifactReader: preparedArtifactReader,
      onChanged: invalidateEntrustedWorkProjection,
    }),
    messages: messageStore,
    execution: entrustedWorkTaskExecution,
  });
  const entrustedWorkOwnerRead = new EntrustedWorkOwnerReadService({
    tasks: taskStore,
    collectiveCalendarReader: createCollectiveWorkCalendarReader(collectiveSourceOperations, privateUserId),
    producerCatalog: needsMeProducerCatalog,
    artifactReader: artifactReview.artifactReader,
    taskExecution: entrustedWorkTaskExecution,
  });
  await app.register(async (scope) => {
    registerEntrustedWorkReadRoutes(scope, {
      service: entrustedWorkOwnerRead,
      callbackRegistry: registry,
      agentKeyRegistry,
    });
  });
  await app.register(async (scope) => {
    registerCustodyOfferRoutes(scope, {
      messageStore,
      taskStore,
      callbackRegistry: registry,
      agentKeyRegistry,
      socketManager,
    });
  });
  await app.register(approvalHubRoutes, {
    registry: approvalProducerRegistry,
  });
  await app.register(evalRepairApprovalRoutes, {
    callbackRegistry: registry,
    ...(f266Cutover.status === 'active' ? { service: f266Cutover.service } : {}),
  });
  await app.register(evalRepairOutcomeRoutes, {
    callbackRegistry: registry,
    ownerUserId: privateUserId,
    ...(evalRepairOutcomeService ? { service: evalRepairOutcomeService } : {}),
  });
  if (personMemoryStore) {
    registerPersonMemoryDecisionRoutes(app, { store: personMemoryStore, socketManager });
  }
  registerHumanDispositionFeedbackRoutes(app, { ledger: humanDispositionLedger });
  registerWaitTerminationRoutes(app, { service: waitTerminationService });
  // F260 Phase A: entity proposal approve/reject (user-auth; one-shot pending→settled)
  registerEntityProposalDecisionRoutes(app, {
    store: entityProposalStore,
    upsertEntities: (entities, context) => {
      if (!memoryServices.evidenceStore.upsertEntities) {
        throw new Error('F260: evidenceStore.upsertEntities not available — entity registration blocked');
      }
      return memoryServices.evidenceStore.upsertEntities(entities, context);
    },
    inspectEntityConflict: (incoming, viewerUserId) => {
      if (!memoryServices.evidenceStore.inspectEntityConflict) {
        throw new Error('F260: evidenceStore.inspectEntityConflict not available — conflict preview blocked');
      }
      return memoryServices.evidenceStore.inspectEntityConflict(incoming, viewerUserId);
    },
    resolveEntityConflict: (incoming, resolution, context) => {
      if (!memoryServices.evidenceStore.resolveEntityConflict) {
        throw new Error('F260: evidenceStore.resolveEntityConflict not available — conflict resolution blocked');
      }
      return memoryServices.evidenceStore.resolveEntityConflict(incoming, resolution, context);
    },
    socketManager,
  });
  // F260 Phase A: callback route for cat_cafe_propose_entity tool (cat-auth)
  // Must use app.register() — Fastify encapsulation scopes the callback auth
  // preHandler hook to this plugin. Plain function call on top-level app would
  // skip the hook → 401 unknown_invocation (bug fix, 2026-07-10).
  await app.register(callbackProposeEntityRoutes, {
    registry,
    entityProposalStore,
    socketManager,
    messageStore,
    approvalIngress,
  });
  // F221 Phase B: taste proposal approve/reject (user-auth; two-phase CAS approve)
  registerTasteProposalDecisionRoutes(app, {
    tasteProposalStore,
    socketManager,
    writeVignette: tasteProposalWriter,
    approvalCoordinator: tasteApprovalCoordinator,
  });
  // F221 Phase B: callback route for cat_cafe_propose_taste tool (cat-auth)
  await app.register(callbackProposeTasteRoutes, {
    registry,
    tasteProposalStore,
    socketManager,
    messageStore,
    approvalIngress,
    tasteRepository,
    lifecycleStore: tasteMemoryLifecycleStore,
  });
  registerEventMemoryCorrectionDecisionRoutes(app, {
    store: eventMemoryCorrectionProposalStore,
    lifecycle: eventMemoryLifecycleService,
    socketManager,
  });
  await app.register(callbackProposeEventMemoryCorrectionRoutes, {
    registry,
    eventMemoryStore: memoryServices.eventMemoryStore,
    proposalStore: eventMemoryCorrectionProposalStore,
    approvalIngress,
    sourceReaders: eventMemorySourceReaders,
  });
  // F246 Phase B: dispatch proposal approve/reject endpoints
  await app.register(dispatchProposalRoutes, {
    store: dispatchProposalStore,
    ...(dispatchActionApprovalService
      ? {
          approveAction: (proposal, userId, ownerAuthProvenance) =>
            dispatchActionApprovalService!.approve(proposal, userId, ownerAuthProvenance),
        }
      : {}),
    ...(actionSuccessorRecovery
      ? {
          recoverApprovedAction: (lease) => actionSuccessorRecovery!.recoverDispatch(lease),
        }
      : {}),
    deliverMessage: async (proposal, ownerAuthProvenance) => {
      const targetCatIds = proposal.targetCats as CatId[];
      const senderCatId = proposal.senderCatId as CatId;
      const storedMsg = await messageStore.append({
        from: { kind: 'agent', catId: senderCatId },
        userId: proposal.ownerUserId,
        content: proposal.content,
        mentions: targetCatIds,
        origin: 'callback',
        timestamp: Date.now(),
        threadId: proposal.targetThreadId,
        extra: {
          isExplicitPost: true as const,
          crossPost: {
            sourceThreadId: proposal.sourceThreadId,
            effectClass: 'assign_work' as const,
          },
          ...(targetCatIds.length ? { targetCats: targetCatIds } : {}),
        },
        ...(proposal.replyTo ? { replyTo: proposal.replyTo } : {}),
      });

      // R2 P1-1 fix: Enqueue target cats for A2A dispatch so they actually wake up.
      // Without this, the message appears in the target thread but nobody acts on it.
      if (targetCatIds.length > 0 && socketManager) {
        try {
          await enqueueA2ATargets(
            {
              socketManager,
              messageStore,
              ...(invocationTracker ? { invocationTracker } : {}),
              ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
              ...(queueProcessor ? { queueProcessor } : {}),
              ...(invocationQueue ? { invocationQueue } : {}),
              log: app.log,
            },
            {
              targetCats: targetCatIds,
              content: proposal.content,
              userId: proposal.ownerUserId,
              ownerAuthProvenance,
              threadId: proposal.targetThreadId,
              triggerMessage: storedMsg,
              callerCatId: senderCatId,
            },
          );
        } catch (err) {
          app.log.error(
            { err, proposalId: proposal.proposalId },
            '[F246] enqueueA2ATargets failed on approve — message delivered but cats may not wake',
          );
        }
      }

      // Broadcast to target thread so connected clients see the message in real time
      socketManager?.broadcastAgentMessage(
        {
          type: 'text',
          catId: senderCatId,
          content: proposal.content,
          origin: 'callback',
          messageId: storedMsg.id,
          extra: {
            isExplicitPost: true as const,
            crossPost: { sourceThreadId: proposal.sourceThreadId },
            ...(targetCatIds.length ? { targetCats: targetCatIds } : {}),
          },
          timestamp: Date.now(),
        },
        proposal.targetThreadId,
      );
      return storedMsg.id;
    },
    notifyUpdate: (proposal) => {
      socketManager?.emitToUser?.(proposal.ownerUserId, 'proposal_updated', {
        proposalId: proposal.proposalId,
        featureId: 'F193',
        status: proposal.status,
      });
    },
  });
  // F222: Frustration auto-issue routes
  await app.register(frustrationIssueRoutes, { frustrationIssueStore });

  // F142: the shared binding store above is reused by threadCatsRoutes AND connector gateway.
  {
    const allCatConfigs = catRegistry.getAllConfigs();
    await app.register(threadCatsRoutes, {
      threadStore,
      agentRegistry,
      bindingStore: connectorBindingStore,
      getCatDisplayName: (catId: string) => allCatConfigs[catId]?.displayName ?? catId,
      getAllCatIds: () => Object.keys(allCatConfigs),
      isCatAvailable: (catId: string) => isCatAvailable(catId),
      resolveConversationFallbackTarget: async (threadId: string) =>
        (await router.resolveConversationTargetsAtAdmission([], threadId))[0],
    });
  }
  await app.register(tasksRoutes, {
    ordinaryTaskHandoffs,
    messageStore,
    taskStore,
    threadStore,
    socketManager,
    deploymentWaitLifecycleHolder,
    humanTerminal: entrustedWorkHumanTerminal,
  });
  registerDeploymentWaitProjectionRoutes(app, {
    threadStore,
    taskStore,
    ...(runtimeDeploymentContext
      ? {
          candidateSubjectRef: runtimeDeploymentSubjectRef(
            runtimeDeploymentContext.installationId,
            runtimeDeploymentContext.deploymentId,
          ),
        }
      : {}),
    observeDeployment: async (input) => runtimeDeploymentContext?.provider.observe(input) ?? null,
    readCandidate: async () =>
      runtimeDeploymentContext ? resolveRuntimeDeploymentCandidate(runtimeDeploymentContext.runtimeRoot) : null,
    proveCandidateInclusion: async (targetRevision, candidateRevision) =>
      runtimeDeploymentContext
        ? resolveRuntimeDeploymentInclusionProof({
            runtimeRoot: runtimeDeploymentContext.runtimeRoot,
            targetRevision,
            runningRevision: candidateRevision,
          })
        : null,
  });

  // F093: World Engine — routes (store + coordinator initialized above, before AgentRouter)
  await app.register(worldRoutes, { worldStore, coordinator: worldCoordinator });

  await app.register(backlogRoutes, { backlogStore, threadStore, messageStore });

  // F233 Phase C C2b: feat trajectory query routes (Hub UI + 轨迹下钻)
  // Store: Redis-backed in production; InMemory fallback if Redis unavailable (preserves
  // route shape for opus-48 UI smoke tests but data wipes on restart — production needs Redis)
  const { InMemoryFeatTrajectoryStore, RedisFeatTrajectoryStore } = await import(
    './domains/feat-trajectory/FeatTrajectoryStore.js'
  );
  const featTrajectoryStore = redisClient
    ? new RedisFeatTrajectoryStore(redisClient)
    : new InMemoryFeatTrajectoryStore();
  // Cloud round 3 P2 fix: pass callback auth registry so MCP / callback paths
  // get request.callbackPrincipal populated (Fastify encapsulation: sibling
  // plugin hooks don't reach us; events.ts / eval-hub / schedule all follow
  // this same pattern).
  await app.register(featTrajectoryRoutes, {
    featTrajectoryStore,
    callbackRegistry: registry,
    agentKeyRegistry,
  });

  // F252 Phase C: Story rendering BFF (consumes feat trajectory projection → rendering DTO)
  const { storyRenderingRoutes } = await import('./routes/story-rendering.js');
  await app.register(storyRenderingRoutes, {
    featTrajectoryStore,
    threadStore: threadStore as { get(threadId: string): Promise<{ id: string; title?: string | null } | null> },
    callbackRegistry: registry,
    agentKeyRegistry,
  });

  // F252 Phase D: Story annotations CRUD (annotations at arbitrary timeline points)
  const { AnnotationFileStore } = await import('./domains/story/annotation-store.js');
  const { storyAnnotationRoutes } = await import('./routes/story-annotations.js');
  const annotationDataDir = process.env.ANNOTATION_DATA_DIR ?? `${findMonorepoRoot(process.cwd())}/data/stories`;
  const annotationStore = new AnnotationFileStore(annotationDataDir);
  await app.register(storyAnnotationRoutes, {
    annotationStore,
    callbackRegistry: registry,
    agentKeyRegistry,
  });

  // F252 Phase D: Story export (sanitized public sharing)
  const { StoryExportStore } = await import('./domains/story/export-store.js');
  const { storyExportRoutes } = await import('./routes/story-export.js');
  const { buildCatIdentityAliases } = await import('./domains/story/content-sanitizer.js');
  const exportStore = new StoryExportStore(annotationDataDir); // shares data/stories/ root
  // Build identity alias map from breeds config for Class D redaction coverage
  const exportCatConfig = bootstrapDefaultCatCatalog();
  const catIdentityAliases = buildCatIdentityAliases(
    exportCatConfig.breeds.map((b) => ({
      catId: b.catId,
      name: b.name,
      displayName: b.displayName,
      nickname: b.nickname,
      mentionPatterns: [...b.mentionPatterns],
      variants: b.variants.map((v) => ({
        catId: v.catId,
        // clowder-ai#1090: forward variant-scoped identity so the sanitizer
        // redacts renamed members (multi-variant breeds now persist
        // per-member name / nickname; without these fields the sanitizer
        // would rebuild the redaction set from breed identity only).
        name: v.name,
        nickname: v.nickname,
        displayName: v.displayName,
        variantLabel: v.variantLabel,
        mentionPatterns: v.mentionPatterns ? [...v.mentionPatterns] : undefined,
      })),
    })),
    'coCreator' in exportCatConfig && exportCatConfig.coCreator
      ? {
          name: exportCatConfig.coCreator.name,
          aliases: [...exportCatConfig.coCreator.aliases],
          mentionPatterns: [...exportCatConfig.coCreator.mentionPatterns],
        }
      : undefined,
  );
  await app.register(storyExportRoutes, {
    exportStore,
    annotationStore,
    catIdentityAliases,
    fetchTranscriptEvents: async (storyId) => {
      // Parse session:<sessionId> → look up via sessionChainStore → read JSONL via transcriptReader
      const sessionMatch = storyId.match(/^session:(.+)$/);
      if (!sessionMatch) return []; // feat: stories or unknown format — no transcript source yet

      const sessionId = sessionMatch[1];
      const session = await sessionChainStore.get(sessionId);
      if (!session) return [];

      // Read all events (limit=10000 to get full session; paginate if needed)
      const result = await transcriptReader.readEvents(sessionId, session.threadId, session.catId, undefined, 10000);

      // Map TranscriptReader events to export format
      return result.events.map((te) => {
        const ev = te.event as Record<string, unknown>;
        return {
          id: `${te.sessionId}:${te.eventNo}`,
          at: te.t,
          kind: (ev.kind as string) ?? (ev.type as string) ?? 'unknown',
          content:
            typeof ev.content === 'string'
              ? ev.content
              : typeof ev.text === 'string'
                ? ev.text
                : JSON.stringify(ev.content ?? ev),
          ...(ev.toolName !== undefined && { toolName: ev.toolName as string }),
          ...(ev.toolArgs !== undefined && {
            toolArgs: typeof ev.toolArgs === 'string' ? ev.toolArgs : JSON.stringify(ev.toolArgs),
          }),
          ...(ev.toolResult !== undefined && {
            toolResult: typeof ev.toolResult === 'string' ? ev.toolResult : JSON.stringify(ev.toolResult),
          }),
          ...(te.catId && { catId: te.catId }),
        };
      });
    },
    callbackRegistry: registry,
    agentKeyRegistry,
  });

  // F076: External projects + Need Audit
  const { ExternalProjectStore } = await import('./domains/projects/external-project-store.js');
  const { IntentCardStore } = await import('./domains/projects/intent-card-store.js');
  const { NeedAuditFrameStore } = await import('./domains/projects/need-audit-frame-store.js');
  const externalProjectStore = new ExternalProjectStore(redis);
  const intentCardStore = new IntentCardStore();
  const needAuditFrameStore = new NeedAuditFrameStore();
  const { ResolutionStore } = await import('./domains/projects/resolution-store.js');
  const { SliceStore } = await import('./domains/projects/slice-store.js');
  const { RefluxPatternStore } = await import('./domains/projects/reflux-pattern-store.js');
  const resolutionStore = new ResolutionStore();
  const sliceStore = new SliceStore();
  const refluxPatternStore = new RefluxPatternStore();
  await app.register(externalProjectRoutes, { externalProjectStore, needAuditFrameStore, backlogStore });
  await app.register(intentCardRoutes, { externalProjectStore, intentCardStore });
  await app.register(resolutionRoutes, { externalProjectStore, resolutionStore });
  await app.register(sliceRoutes, { externalProjectStore, sliceStore });
  await app.register(refluxRoutes, { externalProjectStore, refluxPatternStore });
  await app.register(executionDigestRoutes, { executionDigestStore });
  if (workflowSopStore) {
    await app.register(workflowSopRoutes, { workflowSopStore, backlogStore });
  }
  await app.register(summariesRoutes, { summaryStore, socketManager });
  await app.register(projectsRoutes);
  await app.register(mkdirRoute);
  await app.register(agentHooksRoutes);
  await app.register(governanceStatusRoute);
  await app.register(projectSetupRoute, {
    memoryBootstrapService: expeditionBootstrapService as { bootstrap: (p: string, o?: unknown) => Promise<unknown> },
    socketManager: socketManager ?? undefined,
  });
  await app.register(projectsBootstrapRoutes, {
    stateManager: indexStateManager,
    bootstrapService: expeditionBootstrapService,
    socketManager: socketManager!,
    getFingerprint,
  });
  await app.register(exportRoutes, { messageStore, threadStore });
  await app.register(debugInvocationExportRoutes, { projectRoot: findMonorepoRoot(process.cwd()) });
  await app.register(configRoutes, { threadStore });
  await app.register(configSecretsRoutes);
  await app.register(rulesRoutes);
  await app.register(promptInjectionRoutes);
  await app.register(promptInjectionManifestRoutes);
  await app.register(promptInjectionPreviewRoutes);
  await app.register(servicesRoutes, {
    lifecycle: {
      autoStartEnabled: true,
      onServiceReady: async ({ service, operator, reason }) => {
        if (service.id !== 'embedding-model' || !memoryServices.indexBuilder) return;
        const activationMode = resolvedEmbedMode === 'shadow' ? 'shadow' : 'on';
        const activation = await memoryServices.embeddingLifecycle.activate(activationMode);
        if (!activation.ok) {
          const detail = activation.reason ?? activation.status;
          appendServiceLog(service.id, `[start] memory embedding activation degraded: ${detail}\n`);
          app.log.warn(
            { serviceId: service.id, operator, reason, activation },
            '[api] F102: embedding service ready but memory activation degraded',
          );
          return;
        }
        appendServiceLog(service.id, `[start] embedding service ready (${reason}); scheduling vector catch-up\n`);
        app.log.info(
          { serviceId: service.id, operator, reason },
          '[api] F102: embedding service ready; scheduling vector catch-up',
        );
        const startedAt = Date.now();
        try {
          const result = await memoryServices.embeddingLifecycle.catchUpAfterReady();
          const elapsedMs = Date.now() - startedAt;
          appendServiceLog(
            service.id,
            `[start] vector catch-up completed: ${result.docsEmbedded} embedded (${elapsedMs}ms)\n`,
          );
          app.log.info(
            `[api] F102: embedding service vector catch-up completed - ${result.docsEmbedded} embedded (${elapsedMs}ms)`,
          );
        } catch (error) {
          appendServiceLog(service.id, `[start] vector catch-up failed: ${String(error)}\n`);
          app.log.warn({ err: error, serviceId: service.id }, '[api] F102: embedding service vector catch-up failed');
        }
      },
      onServiceUnavailable: ({ service, operator, reason }) => {
        if (service.id !== 'embedding-model') return;
        memoryServices.embeddingLifecycle.deactivate();
        appendServiceLog(service.id, `[${reason}] memory embedding dependencies deactivated\n`);
        app.log.info(
          { serviceId: service.id, operator, reason },
          '[api] F102: memory embedding dependencies deactivated',
        );
      },
    },
  });
  await app.register(featureDocDetailRoutes);
  await app.register(accountsRoutes);
  await app.register(claudeRescueRoutes);
  await app.register(auditRoutes, { threadStore });
  await app.register(capabilitiesRoutes, {
    resolvePluginMcpView: () => pluginRuntime.supervisor.resolveMemberMcpView(),
  });
  await app.register(audioProxyRoutes);

  {
    const { createAdapterRegistry, deduplicateInFlightCapabilitySource } = await import('./marketplace/index.js');
    const { selectCodexCapabilitySourceService } = await import(
      './domains/cats/services/agents/providers/CodexAppServerCapabilitySource.js'
    );
    const { loadClaudeCatalog, loadOpenClawCatalog, loadAntigravityCatalog } = await import(
      './marketplace/catalog-loaders.js'
    );
    const registry = createAdapterRegistry({
      claude: { catalogLoader: loadClaudeCatalog },
      codex: {
        sourceLoader: deduplicateInFlightCapabilitySource(async () => {
          const codexCapabilityService = selectCodexCapabilitySourceService(agentRegistry.getAllEntries().values());
          if (!codexCapabilityService?.requestNativeCapabilitySource) {
            throw new Error('Codex provider source unavailable');
          }
          const selectedCatId = [...agentRegistry.getAllEntries()].find(
            ([, service]) => service === codexCapabilityService,
          )?.[0];
          if (!selectedCatId) throw new Error('Codex provider source owner unavailable');
          const projectRoot = resolveActiveProjectRoot(process.cwd());
          const catConfig = catRegistry.tryGet(selectedCatId)?.config;
          const account = resolveCatRuntimeAccount(projectRoot, selectedCatId, 'openai', catConfig);
          if (!account && !usesNativeToolConfiguration(catConfig))
            throw new Error('Codex provider source account unavailable');
          const accountError = account && validateRuntimeProviderBinding('openai', account, catConfig?.defaultModel);
          if (accountError) throw new Error(accountError);
          try {
            return await codexCapabilityService.requestNativeCapabilitySource({
              ...(account ? { account } : {}),
              cliConfigArgs: catConfig?.cliConfigArgs,
              invocationId: 'marketplace-capability-source:' + randomUUID(),
              timeoutMs: 8_000,
              cwd: resolveActiveProjectRoot(),
            });
          } catch (error) {
            app.log.warn({ err: error }, '[api] Codex provider capability source unavailable');
            throw error;
          }
        }),
      },
      openclaw: { catalogLoader: loadOpenClawCatalog },
      antigravity: { catalogLoader: loadAntigravityCatalog },
    });
    await app.register(marketplaceRoutes, { registry });
  }

  await app.register(workspaceRoutes, {
    callbackRegistry: registry,
    agentKeyRegistry,
    threadStore,
    skillConsumptionReceipts,
    socketEmit: (event, data, room) => {
      socketManager?.broadcastToRoom(room, event, data);
    },
    socketEmitWithAck: async (event, data, room) =>
      socketManager ? socketManager.broadcastToRoomWithAck(room, event, data) : [],
  });
  await app.register(workspaceEditRoutes);
  await app.register(workspaceGitRoutes);
  await app.register(terminalRoutes, {
    ...(tmuxGateway ? { tmuxGateway } : {}),
    ...(agentPaneRegistry ? { agentPaneRegistry } : {}),
    portDiscovery,
  });
  await app.register(previewRoutes, {
    portDiscovery,
    gatewayPort: PREVIEW_GATEWAY_ENABLED ? previewGateway.actualPort || PREVIEW_GATEWAY_PORT : 0,
    runtimePorts,
    socketEmit: (event, data, room) => {
      socketManager?.broadcastToRoom(room, event, data);
    },
    socketEmitWithAck: async (event, data, room, timeoutMs) =>
      socketManager ? socketManager.broadcastToRoomWithAck(room, event, data, timeoutMs) : [],
    callbackRegistry: registry,
    agentKeyRegistry,
    threadStore,
  });
  await app.register(avatarsRoutes);
  await app.register(skillsRoutes);
  await app.register(skillsWriteRoutes);
  await app.register((await import('./routes/mount-rules.js')).mountRulesRoutes);
  await app.register((await import('./routes/skills-drift.js')).skillsDriftRoutes);
  await app.register((await import('./routes/mcp-drift.js')).mcpDriftRoutes);
  await app.register((await import('./routes/drift.js')).unifiedDriftRoutes);
  await app.register(memoryRoutes, { memoryStore, threadStore });

  const resolveLocalCodexReader = (catId: string) => {
    const catConfig = catRegistry.tryGet(catId)?.config;
    if (
      !catConfig?.cli ||
      catId === 'gpt-pro' ||
      catConfig.provider === 'openai-chatgpt-pro' ||
      catConfig.clientId !== 'openai' ||
      !agentRegistry.has(catId)
    )
      throw new Error('Session tool unavailable');
    const projectRoot = resolveActiveProjectRoot();
    const account = resolveCatRuntimeAccount(projectRoot, catId, 'openai', catConfig);
    if (!account && !usesNativeToolConfiguration(catConfig)) throw new Error('Codex account unavailable');
    const accountError = account && validateRuntimeProviderBinding('openai', account, catConfig.defaultModel);
    if (accountError) throw new Error(accountError);
    return {
      service: agentRegistry.get(catId),
      ...(account ? { account } : {}),
      cliConfigArgs: catConfig.cliConfigArgs,
      cwd: projectRoot,
    };
  };
  const inspectLocalSession = async (catId: string, sessionId: string) => {
    const catConfig = catRegistry.tryGet(catId)?.config;
    if (!catConfig?.cli || catId === 'gpt-pro' || catConfig.provider === 'openai-chatgpt-pro')
      throw new Error('This member does not use a local command-line tool');
    if (catConfig.clientId === 'opencode') {
      const { readOpenCodeImport } = await import(
        './domains/cats/services/session/import/OpenCodeLocalSessionReader.js'
      );
      const metadata = (await readOpenCodeImport({ sessionId })).sessions[0];
      const { realpath } = await import('node:fs/promises');
      return { ...metadata, projectPath: await realpath(metadata.projectPath) };
    }
    if (catConfig?.clientId === 'anthropic') {
      const { inspectClaudeLocalSession } = await import(
        './domains/cats/services/session/import/LocalSessionInspection.js'
      );
      const metadata = await inspectClaudeLocalSession(sessionId);
      const { realpath } = await import('node:fs/promises');
      return { ...metadata, projectPath: await realpath(metadata.projectPath) };
    }
    const { service, ...configuration } = resolveLocalCodexReader(catId);
    if (!service.inspectLocalSession) throw new Error('This Codex member cannot inspect native sessions');
    const metadata = await service.inspectLocalSession({
      ...configuration,
      sessionId,
      invocationId: 'local-session-import:' + randomUUID(),
      timeoutMs: 8_000,
    });
    const { realpath } = await import('node:fs/promises');
    return { ...metadata, projectPath: await realpath(metadata.projectPath) };
  };

  const listLocalSessions = async (catId: string, limit: number) => {
    const catConfig = catRegistry.tryGet(catId)?.config;
    if (catConfig?.cli && catConfig.clientId === 'opencode') {
      const { readOpenCodeImport } = await import(
        './domains/cats/services/session/import/OpenCodeLocalSessionReader.js'
      );
      return readOpenCodeImport({ limit });
    }
    if (catConfig?.cli && catConfig.clientId === 'anthropic') {
      const { readClaudeRecentSessionIndex } = await import(
        './domains/cats/services/session/import/ClaudeRecentSessionIndex.js'
      );
      return readClaudeRecentSessionIndex(limit, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
    }
    const { service, ...configuration } = resolveLocalCodexReader(catId);
    if (!service.listLocalSessions) throw new Error('This Codex member cannot list native sessions');
    return service.listLocalSessions({
      ...configuration,
      limit,
      invocationId: 'local-session-list:' + randomUUID(),
      timeoutMs: 8_000,
    });
  };

  // Session chain (F24)
  await app.register(sessionChainRoutes, {
    inspectLocalSession,
    listLocalSessions,
    sessionChainStore,
    threadStore,
    messageStore,
    transcriptReader,
    sessionSealer,
    runtimeSessionStore,
    isSessionSwitchBusy: (threadId, catId, userId) =>
      (invocationTracker.has(threadId, catId) && invocationTracker.getUserId(threadId, catId) === userId) ||
      queueProcessor.hasPendingForCat(threadId, userId, catId),
    invocationTracker,
    resolveSessionSealLiveness: (threadId, ownerUserId) =>
      activeExecutionService.resolveWorkingPresence(threadId, ownerUserId),
  });
  const { nativeSessionControlRoutes } = await import('./routes/native-session-control-routes.js');
  await app.register(nativeSessionControlRoutes, {
    enabled: process.env.CAT_CAFE_DEPLOYMENT_ID === 'alpha',
    sessionChainStore,
    threadStore,
    agentRegistry,
    contextEpochOwner,
    deliveryCursorStore,
    isSessionBusy: (threadId, catId, userId) =>
      (invocationTracker.has(threadId, catId) && invocationTracker.getUserId(threadId, catId) === userId) ||
      queueProcessor.hasPendingForCat(threadId, userId, catId),
  });
  const { nativeThreadGoalRoutes } = await import('./routes/native-thread-goal-routes.js');
  await app.register(nativeThreadGoalRoutes, {
    sessionChainStore,
    threadStore,
    messageStore,
    agentRegistry,
    isSessionBusy: (threadId, catId, userId) =>
      (invocationTracker.has(threadId, catId) && invocationTracker.getUserId(threadId, catId) === userId) ||
      queueProcessor.hasPendingForCat(threadId, userId, catId),
    publishMessage: (threadId, stored) =>
      socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          from: stored.from,
          type: 'cat',
          catId: stored.catId,
          content: stored.content,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      }),
  });
  const { nativeThreadReviewRoutes } = await import('./routes/native-thread-review-routes.js');
  await app.register(nativeThreadReviewRoutes, {
    sessionChainStore,
    threadStore,
    messageStore,
    agentRegistry,
    isSessionBusy: (threadId, catId, userId) =>
      (invocationTracker.has(threadId, catId) && invocationTracker.getUserId(threadId, catId) === userId) ||
      queueProcessor.hasPendingForCat(threadId, userId, catId),
    publishMessage: (threadId, stored) =>
      socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          from: stored.from,
          type: 'cat',
          catId: stored.catId,
          content: stored.content,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      }),
  });
  const { nativeThreadStatusRoutes } = await import('./routes/native-thread-status-routes.js');
  await app.register(nativeThreadStatusRoutes, {
    sessionChainStore,
    threadStore,
    agentRegistry,
  });
  const [{ nativeRealtimeCompanionRoutes }, { createRealtimeCompanionAudioSource }] = await Promise.all([
    import('./routes/native-realtime-companion-routes.js'),
    import('./routes/realtime-companion-audio-source.js'),
  ]);
  await app.register(nativeRealtimeCompanionRoutes, {
    enabled: nativeRealtimeCompanionEnabled,
    sessionChainStore,
    threadStore,
    messageStore,
    agentRegistry,
    audioSource: createRealtimeCompanionAudioSource(),
    publishMessage: (threadId, stored) =>
      socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          from: stored.from,
          type: 'cat',
          catId: stored.catId,
          content: stored.content,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      }),
  });
  await app.register(sessionTranscriptRoutes, {
    invocationRecordStore,
    sessionChainStore,
    threadStore,
    transcriptReader,
    transcriptWriter,
    messageStore,
    turnExecutionStore,
    profileRepository,
    memoryCueSourceReader: memoryCueRuntime.sourceReader,
  });
  await app.register(externalRuntimeSessionsRoutes, { sessionChainStore, runtimeSessionStore, threadStore });
  await app.register(sessionHooksRoutes, {
    sessionChainStore,
    sessionSealer,
    transcriptReader,
    contextEpochOwner,
    resolveContextCapability: (catId) => router.contextCapability(catId),
    postCompactContextProjector: createPostCompactContextProjector(router.getStrategyDeps()),
    callbackRegistry: registry,
  });

  // F33 Phase 3: Session strategy config (runtime overrides via Redis)
  if (redis) {
    try {
      await initRuntimeOverrides(redis);
      app.log.info('[api] Session strategy runtime overrides hydrated from Redis');
    } catch (err) {
      app.log.warn(
        `[api] Session strategy hydration failed (best-effort, continuing with empty cache): ${String(err)}`,
      );
    }
  }
  await app.register(sessionStrategyConfigRoutes, {
    resolveContextCapability: (catId) => router.contextCapability(catId as CatId),
  });

  // Voting system (F079)
  const { voteRoutes } = await import('./routes/votes.js');
  await app.register(voteRoutes, { threadStore, socketManager, messageStore });

  // F188 Phase A: rebuild job tracker
  const { RebuildJobTracker } = await import('./domains/memory/RebuildJobTracker.js');
  const rebuildJobTracker = new RebuildJobTracker();

  // Evidence search (SQLite) + reindex endpoint (D-11) + F-4 federated search + F188 rebuild
  await app.register(evidenceRoutes, {
    evidenceStore: memoryServices.evidenceStore,
    messageSearchService,
    getEmbeddingService: () => memoryServices.embeddingLifecycle.getService(),
    indexBuilder: memoryServices.indexBuilder,
    knowledgeResolver: memoryServices.knowledgeResolver,
    rebuildJobTracker,
    // F188 Phase K: enable docs_root_suspicious detector in /api/evidence/status.
    ...(memoryServices.catalog ? { catalog: memoryServices.catalog } : {}),
  });
  // F227: Event Memory query route (GET /api/memory/events)
  await app.register(eventsRoutes, {
    eventMemoryStore: memoryServices.eventMemoryStore,
    lifecycleService: eventMemoryLifecycleService,
    correctionProposalStore: eventMemoryCorrectionProposalStore,
    socketEmit: (event, data, room) => {
      socketManager?.broadcastToRoom(room, event, data);
    },
    // F227 (砚砚 R2 P1): MCP callback auth for the cat_cafe_teleport callbackPost path.
    callbackRegistry: registry,
    agentKeyRegistry,
    // F227 Task 7: corpus sources for the historical backfill route.
    threadStore,
    messageStore,
  });
  await app.register(perspectiveRoutes, {
    repoRoot,
    evidenceStore: memoryServices.evidenceStore,
    knowledgeResolver: memoryServices.knowledgeResolver,
    ...(memoryServices.catalog && memoryServices.collectionStores
      ? { graphCatalog: memoryServices.catalog, graphStores: memoryServices.collectionStores }
      : {}),
  });

  // F163: Knowledge promotion admin API (localhost-only)
  const { f163AdminRoutes } = await import('./routes/f163-admin.js');
  await app.register(f163AdminRoutes, {
    evidenceStore: memoryServices.evidenceStore as unknown as Parameters<typeof f163AdminRoutes>[1]['evidenceStore'],
  });

  // F163 Phase C: Knowledge audit routes (contradiction check, flag-review, review-queue, health-report)
  const { f163AuditRoutes } = await import('./routes/f163-audit-routes.js');
  await app.register(f163AuditRoutes, {
    evidenceStore: memoryServices.evidenceStore as unknown as Parameters<typeof f163AuditRoutes>[1]['evidenceStore'],
    knowledgeResolver: memoryServices.knowledgeResolver,
    markerQueue: memoryServices.markerQueue,
    repoRoot,
    docsRoot,
  });

  // F152 Phase C: Distillation routes (global lesson reflow)
  if (memoryServices.globalStore) {
    const { DistillationService } = await import('./domains/memory/distillation-service.js');
    const distilledRoot = join(memoryServices.dataDir ?? join(homedir(), '.cat-cafe'), 'distilled-truths');
    const distillationService = new DistillationService(memoryServices.store, memoryServices.globalStore, {
      distilledRoot,
    });
    await distillationService.initialize();
    await app.register(distillationRoutes, {
      evidenceStore: memoryServices.evidenceStore,
      distillationService,
    });
  }

  // F129: Pack system routes (reuse shared packStore from above)
  {
    const { PackSecurityGuard } = await import('./domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('./domains/packs/PackLoader.js');
    const packGuard = new PackSecurityGuard();
    const packLoader = new PackLoader(packStore, packGuard);
    const root = findMonorepoRoot(process.cwd());
    await app.register(packsRoutes, {
      packLoader,
      catTemplatePath: join(root, 'cat-template.json'),
      sharedRulesPath: join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md'),
      skillsManifestPath: join(root, 'cat-cafe-skills', 'manifest.yaml'),
    });
  }

  // Reflect (SQLite-backed reflection)
  await app.register(reflectRoutes, {
    reflectionService: memoryServices.reflectionService,
  });

  // Phase H: Knowledge Emergence Feed API
  await knowledgeFeedRoutes(app, {
    ownerUserId: privateUserId,
    markerQueue: memoryServices.markerQueue,
    db: memoryServices.store.getDb(),
    materializationService: memoryServices.materializationService,
    catalog: memoryServices.catalog,
    collectionStores: memoryServices.collectionStores,
  });

  // F186: Library catalog API (Phase D: includes external collections + dataDir for register endpoint)
  if (memoryServices.catalog) {
    const libraryStores =
      memoryServices.collectionStores ?? new Map<string, import('./domains/memory/interfaces.js').IEvidenceStore>();
    if (!libraryStores.has('project:cat-cafe')) libraryStores.set('project:cat-cafe', memoryServices.store);
    if (memoryServices.globalStore && !libraryStores.has('global:methods'))
      libraryStores.set('global:methods', memoryServices.globalStore);
    const { memoryPageReadRoutes } = await import('./routes/memory-page-read.js');
    await app.register(memoryPageReadRoutes, {
      ownerUserId: privateUserId,
      catalog: memoryServices.catalog,
      stores: libraryStores,
      searchSources: { tasteRepository, messageSearchService },
      brakeSources: { eventMemoryStore: memoryServices.eventMemoryStore, threadStore, messageStore },
      recallSources: {
        ...recallOwnerMessageSources,
        threadStore,
        messageStore,
        invocationRecordStore,
        turnExecutionStore,
        ...(personMemoryStore ? { personMemoryStore } : {}),
        cueSourceReader: memoryCueRuntime.sourceReader,
        profileMemoryStore: profileMemoryLifecycleStore,
      },
      evidenceDb: memoryServices.store.getDb(),
      markerQueue: memoryServices.markerQueue,
      repoRoot,
      docsRoot,
    });
    await app.register(libraryRoutes, {
      catalog: memoryServices.catalog,
      stores: libraryStores,
      dataDir: memoryServices.dataDir,
      managedVaultBase: memoryServices.dataDir,
      getEmbeddingService: () => memoryServices.embeddingLifecycle.getService(),
      getEmbedMode: () => {
        const mode = memoryServices.embeddingLifecycle.getMode();
        return mode === 'off' ? undefined : mode;
      },
      privateOwnerUserId: privateUserId,
      // F188 Phase F AC-F9: pass redis for tool-usage-metrics endpoint (砚砚 review P1-2)
      ...(redisClient ? { redis: redisClient } : {}),
      // AC-H1 P1 R3: runtime exclude updates for parent IndexBuilder
      indexBuilder: memoryServices.indexBuilder as import('./domains/memory/IndexBuilder.js').IndexBuilder | undefined,
      parentRoot: docsRoot,
    });
  }

  // Memory governance (publish workflow)
  const governanceStore = new MemoryGovernanceStore();
  await app.register(memoryPublishRoutes, { governanceStore });

  // F142-B: Build unified command registry at startup (AC-B5)
  const commandRegistry = new CommandRegistry(CORE_COMMANDS);
  const skillsDir = join(findMonorepoRoot(process.cwd()), 'cat-cafe-skills');
  const skillCommandMap = await parseManifestSlashCommands(skillsDir);
  for (const [skillId, cmds] of skillCommandMap) {
    commandRegistry.registerSkillCommands(
      skillId,
      cmds.map((c) => ({
        ...c,
        usage: c.usage ?? c.name,
        source: 'skill' as const,
        category: 'connector',
        skillId,
      })),
      app.log,
    );
  }
  app.log.info(
    `[api] F142-B: CommandRegistry loaded (${commandRegistry.getAll().length} commands, ${skillCommandMap.size} skills)`,
  );

  // Commands route needs the configured opus service for task extraction.
  // Lazy-init: empty catalog (first-run) has no opus entry yet — defer until first use.
  // 砚砚 Step-3 P1 re-review: invoke() must directly return AsyncIterable
  // (not Promise<AsyncIterable>), otherwise `for await (... of svc.invoke())`
  // crashes at runtime. Use sync generator wrapper that defers async setup
  // to first yield.
  let _opusService: AgentService | undefined;
  const opusService: AgentService = {
    invoke(prompt, options) {
      // Sync return of AsyncGenerator — IS AsyncIterable. Lazy init happens
      // before first yield, then delegates.
      return (async function* opusLazyInvoke() {
        if (!_opusService) {
          const opusConfig = catRegistry.tryGet('opus')?.config;
          if (opusConfig?.carrier === 'sdk') {
            _opusService = new ClaudeSdkAgentService({ catId: 'opus' as CatId });
          } else {
            const { createClaudeAgentServiceForCanary } = await import(
              './domains/cats/services/agents/providers/claude-carrier-factory.js'
            );
            _opusService = createClaudeAgentServiceForCanary('opus' as CatId);
          }
        }
        yield* _opusService.invoke(prompt, options);
      })();
    },
  };
  await app.register(commandsRoutes, {
    messageStore,
    taskStore,
    socketManager,
    opusService,
    threadStore,
    registry: commandRegistry,
  });
  await app.register(signalsRoutes, {});
  await app.register(signalStudyRoutes, { threadStore });
  await app.register(signalCollectionRoutes);
  await app.register(signalPodcastRoutes, {
    messageStore,
    threadStore,
    invocationQueue,
    queueProcessor,
  });

  // Serve uploaded files (images)
  const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
  await app.register(uploadsRoutes, { uploadDir });
  await app.register(refAudioUploadRoutes);

  // F34: TTS Provider (mlx-audio → Python TTS server)
  // Drop the eager baseUrl injection so the provider resolves the TTS
  // endpoint via service manifest + persisted config on every request.
  // /reconfigure-driven port changes therefore apply without restarting
  // the API (codex P1 2026-05-26). Explicit TTS_URL env is still honored
  // because resolveServiceEndpoint reads endpointEnvVars first.
  const ttsRegistry = new TtsRegistry();
  ttsRegistry.register(new MlxAudioTtsProvider());
  const ttsCacheDir = resolveTtsCacheDir();
  const listenModeDbPath = resolveDocumentListenStatePath();
  const documentListenRepository = new DocumentListenRepository(listenModeDbPath);
  await documentListenRepository.initialize();
  await app.register(ttsRoutes, { ttsRegistry, cacheDir: ttsCacheDir, documentListenRepository });
  initVoiceBlockSynthesizer(ttsRegistry, ttsCacheDir);
  // F202 W2-5b: Host messages carrying audio / file / gallery blocks reach the plugin stream as Host
  // media references, published once after materialization (text-only audio via outbound speech).
  const outboundSpeech = createListenAssetSpeech(ttsRegistry, ttsCacheDir);
  app.addHook('onClose', async () => outboundSpeech.close());
  outboundMediaPublication = new OutboundMediaPublication({
    store: pluginRuntime.outboundMedia,
    messages: rawMessageStore,
    events: messagingStores.events,
    ledger: pluginRuntime.mediaLedger,
    resolvePath: createHostMediaPathResolver(
      hostMediaPathRootsFromEnv(process.env, getDefaultConnectorMediaDir(process.env.CONNECTOR_MEDIA_DIR)),
    ),
    speech: outboundSpeech,
    onPublished: subscriptionDrainScheduler.schedule,
    onPublishFailure: (error, messageId) => {
      app.log.error({ error, messageId }, '[messaging] outbound media publication failed; recovered at next start');
    },
  });
  void outboundMediaPublication
    .recover()
    .catch((error: unknown) => app.log.error({ error }, '[messaging] outbound media recovery failed'));
  initStreamingTtsRegistry(ttsRegistry);
  startTtsCacheCleaner(ttsCacheDir, documentListenRepository);
  app.addHook('onClose', async () => documentListenRepository.close());

  // C1+C2: Web Push Notifications (optional — requires VAPID keys)
  const pushSubscriptionStore = createPushSubscriptionStore(redis);
  const resolveVapidPublicKey = (): string => process.env.VAPID_PUBLIC_KEY ?? '';
  const configurePushServiceFromEnv = () => {
    const currentVapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? '';
    const currentVapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? '';
    const currentVapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:cat-cafe@localhost';
    if (!currentVapidPublicKey || !currentVapidPrivateKey) {
      resetPushNotificationService();
      return null;
    }
    return initPushNotificationService({
      subscriptionStore: pushSubscriptionStore,
      vapidPublicKey: currentVapidPublicKey,
      vapidPrivateKey: currentVapidPrivateKey,
      vapidSubject: currentVapidSubject,
    });
  };
  const pushService = configurePushServiceFromEnv();
  if (pushService) {
    app.log.info('[api] Web Push enabled (VAPID configured)');
  } else {
    app.log.info('[api] Web Push disabled (VAPID keys not set)');
  }
  let pushConfigUnsub: (() => void) | null = configEventBus.onKeysChange(
    ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    () => {
      const nextPushService = configurePushServiceFromEnv();
      if (nextPushService) {
        app.log.info('[api] Web Push hot-reloaded (VAPID configured)');
      } else {
        app.log.info('[api] Web Push hot-reloaded disabled (VAPID keys not set)');
      }
    },
  );
  await app.register(pushRoutes, {
    pushSubscriptionStore,
    pushService,
    vapidPublicKey: resolveVapidPublicKey(),
    getPushService: getPushNotificationService,
    getVapidPublicKey: resolveVapidPublicKey,
  });

  // F-BLOAT: Progressive disclosure docs endpoints (no auth, static content)
  await app.register(registerCallbackDocsRoutes);

  // F149 Phase C: graceful shutdown for ACP process pools
  app.addHook('onClose', async () => {
    for (const pool of acpPoolRegistry.values()) {
      await pool.closeAll();
    }
    acpPoolRegistry.clear();
  });

  // F254: graceful shutdown for pooled Codex app-server hosts and Unix sockets.
  app.addHook('onClose', async () => {
    for (const pool of codexAppServerPoolRegistry.values()) {
      await pool.closeAll();
    }
    codexAppServerPoolRegistry.clear();
  });

  app.addHook('onClose', async () => {
    await agentKeySidecarRenewalLoop?.stop();
  });

  let runtimeSessionSealReaperTimer: ReturnType<typeof setInterval> | null = null;
  app.addHook('onClose', async () => {
    if (runtimeSessionSealReaperTimer) {
      clearInterval(runtimeSessionSealReaperTimer);
      runtimeSessionSealReaperTimer = null;
    }
  });

  let invocationOwnerReaperTimer: ReturnType<typeof setInterval> | null = null;
  app.addHook('onClose', async () => {
    if (invocationOwnerReaperTimer) {
      clearInterval(invocationOwnerReaperTimer);
      invocationOwnerReaperTimer = null;
    }
  });

  // F167 S.1-c: the sweep timer is created after listen (it needs invokeTrigger), but
  // Fastify rejects addHook once listening — so register the cleanup hook here and
  // late-bind the timer handle.
  let managedCommandWakeRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  app.addHook('onClose', async () => {
    if (managedCommandWakeRecoveryTimer) {
      clearInterval(managedCommandWakeRecoveryTimer);
      managedCommandWakeRecoveryTimer = null;
    }
  });

  // F192 Phase I: the observer is created after listen alongside the scheduler
  // delivery boundary, so register cleanup now and late-bind its handle below.
  let designGateThresholdObserver: { close(): void } | null = null;
  app.addHook('onClose', async () => designGateThresholdObserver?.close());
  let processCpuCapture: { close(): Promise<void> } | undefined;
  app.addHook('onClose', async () => processCpuCapture?.close());

  // New managed HTTP launches must never race their persistent stdio migration.
  const migratedCodexServers = await migrateStartupCodexMcpConfig(process.cwd());
  if (migratedCodexServers.length) {
    app.log.info(
      { serverNames: migratedCodexServers },
      '[api] migrated owned Codex stdio entries; explicit rollback profile preserved',
    );
  }

  // #603: Preload governance overlay (.local / .local-override)
  // Start listening
  let address: string;
  try {
    const { reapStaleCliProcessOwners } = await import('./utils/cli-process-owner-reaper.js');
    const { reapStaleClaudeBgJobOwners } = await import('./utils/claude-bg-job-owner-reaper.js');
    const configuredOwnerGrace = Number.parseInt(process.env.CAT_CAFE_SUPERVISOR_KILL_GRACE_MS ?? '3000', 10);
    const ownerKillGraceMs =
      Number.isSafeInteger(configuredOwnerGrace) && configuredOwnerGrace > 0 ? configuredOwnerGrace : 3_000;
    const ownerRecoveryLog = {
      info: (message: string) => app.log.info(message),
      warn: (message: string) => app.log.warn(message),
    };
    const ownerRecovery = await reapStaleCliProcessOwners({
      dataDir: process.env.CAT_CAFE_DATA_DIR,
      killGraceMs: ownerKillGraceMs,
      log: ownerRecoveryLog,
    });
    if (ownerRecovery.foundOwners > 0 || ownerRecovery.invalidManifests > 0) {
      app.log.info({ result: ownerRecovery }, '[api] CLI process owner startup recovery completed');
    }
    const claudeBgOwnerRecovery = await reapStaleClaudeBgJobOwners({
      dataDir: process.env.CAT_CAFE_DATA_DIR,
      killGraceMs: ownerKillGraceMs,
      log: ownerRecoveryLog,
    });
    if (claudeBgOwnerRecovery.foundOwners > 0 || claudeBgOwnerRecovery.invalidManifests > 0) {
      app.log.info({ result: claudeBgOwnerRecovery }, '[api] Claude bg job owner startup recovery completed');
    }
    const { initGovernanceOverlay } = await import('./domains/cats/services/context/SystemPromptBuilder.js');
    await initGovernanceOverlay();
    address = await listenBeforeTurnExecutionRecovery({
      listen: async () => {
        const listening = await app.listen({ port: PORT, host: HOST });
        startupMilestone('http-listening');
        processCpuCapture = startProcessCpuCapture({
          enabled: process.env.CAT_CAFE_CPU_CAPTURE_ONCE === '1',
          dataDir: process.env.CAT_CAFE_DATA_DIR ?? join(homedir(), '.cat-cafe'),
          logger: app.log,
        });
        releaseHostListening();
        await initialPlugins?.activate();
        return listening;
      },
      recover: async () => {
        if (!redis) return;
        const authRecovery = await turnExecutionStore.reconcileStartup({ processStartedAt: PROCESS_START_AT });
        const liveExecutionOwners = await cliExecutionOwnerService.listLive();
        const childReconciler = new TurnExecutionStartupReconciler({
          store: turnExecutionStore,
          settleEndedTurnResponse: (turn) => settleTurnResponse(turn, responseOutcomeForEndedTurn(turn)),
        });
        const childRecovery = liveExecutionOwners.complete
          ? await childReconciler.reconcile({
              processStartedAt: PROCESS_START_AT,
              protectedInvocationIds: liveExecutionOwners.owners.map((owner) => owner.invocationId),
            })
          : {
              interruptedCount: 0,
              invocationIds: [],
              // Ended turns have no owner left to wait for; running ones keep their unknown owners.
              ...(await childReconciler.settleEndedTurnResponses({ processStartedAt: PROCESS_START_AT })),
              reconciledAt: Date.now(),
              skippedReason: 'cli_execution_owner_snapshot_incomplete',
            };
        if (!liveExecutionOwners.complete) {
          app.log.warn(
            { callbackAuthLifecycle: { kind: 'live_execution_owner_snapshot_incomplete' } },
            '[api] Preserved prior running TurnExecutions because external process liveness was unknown',
          );
        }
        const { StartupReconciler } = await import('./domains/cats/services/agents/invocation/StartupReconciler.js');
        const reconciler = new StartupReconciler({
          invocationRecordStore,
          turnExecutionStore,
          taskProgressStore,
          log: app.log,
          processStartAt: PROCESS_START_AT,
          messageStore,
          socketManager: socketManager ?? undefined,
          invocationQueue,
          ...(ballCustodyIngest ? { ballCustody: ballCustodyIngest } : {}),
        });
        const startupRecovery = await reconciler.reconcileOrphans();
        registry.markStartupRecoveryComplete();
        for (const scope of startupRecovery.queueResumeScopes) {
          try {
            await queueProcessor.requestDrain(scope.threadId);
          } catch (error) {
            app.log.warn(
              { error, threadId: scope.threadId, userId: scope.userId },
              '[api] Failed to resume reconciled durable Queue scope',
            );
          }
        }
        app.log.info(
          { authRecovery, childRecovery, startupRecovery },
          '[api] F298 callback auth + TurnExecution + Queue/History startup recovery completed',
        );
      },
      onRecoveryError: (error) => {
        app.log.warn(
          `[api] Runtime promise startup recovery failed; callback admission remains closed: ${String(error)}`,
        );
      },
    });
  } catch (err) {
    await apiInstanceLease?.release().catch(() => {});
    throw err;
  }
  if (runtimeDeploymentContext) {
    try {
      const readiness = await checkReadiness();
      if (readiness.status === 'ready') {
        await runtimeDeploymentContext.ledger.markReady({
          deploymentId: runtimeDeploymentContext.deploymentId,
          bootId: runtimeDeploymentContext.bootId,
          services: ['api'],
        });
      } else {
        app.log.warn({ readiness }, '[F323] API listened but deployment readiness remains unknown');
      }
    } catch (error) {
      app.log.error({ error }, '[F323] failed to persist API readiness; deployment waits remain armed');
    }
  }
  app.log.info(`[api] Server running on ${address}`);
  app.log.info(`[ws] WebSocket server ready`);
  memoryServices.indexBuilder?.startPassageEmbeddingWarmup();

  // F156: Friendly hint for private network access
  if (HOST === '0.0.0.0' && process.env.CORS_ALLOW_PRIVATE_NETWORK !== 'true') {
    app.log.warn(
      '[network] 检测到监听所有网络 (0.0.0.0)，但私网设备访问未开启。' +
        '手机/平板通过局域网或 Tailscale 访问可能被拦截。' +
        '在 .env 中添加 CORS_ALLOW_PRIVATE_NETWORK=true 并重启服务（参考 .env.example）',
    );
  }

  // F118 post-close: stale age only admits a candidate. A serialized explicit
  // reaper must also prove the exact provider/child owner absent or terminal.
  const INVOCATION_OWNER_REAPER_INTERVAL_MS = 5 * 60_000;
  try {
    await invocationOwnerReaper.runOnce();
  } catch (err) {
    app.log.warn({ err }, '[api] F118 invocation owner reaper startup sweep failed (best-effort)');
  }
  invocationOwnerReaperTimer = startSerializedInvocationOwnerReaperInterval({
    reaper: invocationOwnerReaper,
    intervalMs: INVOCATION_OWNER_REAPER_INTERVAL_MS,
    onError: (err) => {
      app.log.warn({ err }, '[api] F118 invocation owner reaper sweep failed (best-effort)');
    },
  });
  invocationOwnerReaperTimer.unref();

  // F145 P0: Kill orphan agent-browser headless Chrome processes from previous sessions.
  try {
    const { cleanOrphanAgentBrowserChrome } = await import('./utils/orphan-chrome-cleaner.js');
    await cleanOrphanAgentBrowserChrome(app.log);
  } catch (err) {
    app.log.warn(`[api] Orphan Chrome cleanup failed (best-effort): ${String(err)}`);
  }

  const RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS = Number.parseInt(
    process.env.CAT_CAFE_RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS ?? '30000',
    10,
  );
  try {
    const startupRuntimeReaper = await runtimeSessionSealReaper.runOnce();
    if (
      startupRuntimeReaper.sealed > 0 ||
      startupRuntimeReaper.pending > 0 ||
      startupRuntimeReaper.skippedMaxRetries > 0 ||
      startupRuntimeReaper.failed > 0
    ) {
      app.log.info({ result: startupRuntimeReaper }, '[api] F211 runtime session seal reaper startup sweep completed');
    }
  } catch (err) {
    app.log.warn(`[api] F211 runtime session seal reaper startup sweep failed (best-effort): ${String(err)}`);
  }
  runtimeSessionSealReaperTimer = startSerializedRuntimeSessionSealReaperInterval({
    runtimeSessionSealReaper,
    intervalMs:
      Number.isSafeInteger(RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS) && RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS > 0
        ? RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS
        : 30_000,
    onResult: (result) => {
      if (result.sealed > 0 || result.failed > 0) {
        app.log.info({ result }, '[api] F211 runtime session seal reaper sweep completed');
      }
    },
    onError: () => {
      // best-effort periodic reaper
    },
  });
  runtimeSessionSealReaperTimer.unref();

  // F118 Hardening: Global session reaper — startup sweep + periodic scan.
  // Reconciles sessions stuck in 'sealing' state that the per-invoke lazy
  // reaper would never visit (e.g., threads with no subsequent invocations).
  const GLOBAL_REAPER_INTERVAL_MS = 5 * 60_000;
  try {
    const startupReaped = await sessionSealer.reconcileAllStuck();
    if (startupReaped > 0) {
      app.log.info(`[api] F118 global reaper: reconciled ${startupReaped} stuck sealing session(s) at startup`);
    }
  } catch (err) {
    app.log.warn(`[api] F118 global reaper startup sweep failed (best-effort): ${String(err)}`);
  }
  const globalReaperTimer = setInterval(async () => {
    try {
      const reaped = await sessionSealer.reconcileAllStuck();
      if (reaped > 0) {
        app.log.info(`[api] F118 global reaper: reconciled ${reaped} stuck sealing session(s)`);
      }
    } catch {
      // best-effort periodic reaper
    }
  }, GLOBAL_REAPER_INTERVAL_MS);
  globalReaperTimer.unref();

  // Log server startup to audit log (best-effort: don't crash if audit dir unwritable)
  const auditLog = getEventAuditLog();
  try {
    await auditLog.append({
      type: AuditEventTypes.SERVER_STARTED,
      data: { address, port: PORT, host: HOST, redis: redisClient ? 'connected' : 'memory' },
    });
  } catch (err) {
    app.log.warn(`[api] Audit log write failed (best-effort): ${String(err)}`);
  }

  // Best-effort: regenerate CLI configs at startup so runtime-derived env
  // (Gemini placeholders, Antigravity sidecar key files) reaches CLI config.
  try {
    const result = await regenerateStartupCliConfigs(process.cwd());
    if (result.generated) {
      app.log.info('[api] CLI configs regenerated at startup');
    }
  } catch (err) {
    app.log.warn(`[api] CLI config regeneration failed (best-effort): ${String(err)}`);
  }

  // clowder-ai#340: Account startup — fail-fast (LL-043 / migration conflict / corrupt credentials).
  // Errors propagate to main().catch → process.exit(1).
  {
    const { accountStartupHook } = await import('./config/account-startup.js');
    const startupResult = accountStartupHook(findMonorepoRoot(process.cwd()));
    app.log.info(`[api] clowder-ai#340 accounts: ${startupResult.accountCount} account(s) loaded`);
    for (const diagnostic of startupResult.unavailableAccounts) {
      app.log.warn({ ...diagnostic }, '[api] account unavailable; other accounts remain usable');
    }
  }

  // F140 Phase 3b: connector invoke trigger (auto-invoke cat after review feedback delivery via polling)
  type StreamingHookPort = Parameters<typeof queueProcessor.setStreamingHook>[0];
  const composeStreamingHook = (): StreamingHookPort => {
    const lifecycle = pluginRuntime.lifecycleDelivery;
    const project = async (operation: string, call: () => Promise<void>): Promise<void> => {
      try {
        await call();
      } catch (err) {
        app.log.warn({ err, operation }, '[messaging] streaming projection failed');
      }
    };
    return {
      async onStreamStart(threadId, catId, invocationId) {
        if (catId && invocationId)
          await project('lifecycle.started', () => lifecycle.onStreamStart(threadId, catId, invocationId));
      },
      async onStreamChunk() {},
      async onStreamEnd(threadId, text, invocationId) {
        if (invocationId) await project('lifecycle.ended', () => lifecycle.onStreamEnd(threadId, text, invocationId));
      },
      async onClosureCatchingUp(threadId, catId, invocationId) {
        if (invocationId)
          await project('lifecycle.catching_up', () => lifecycle.onClosureCatchingUp(threadId, catId, invocationId));
      },
      async onClosureBlocked(threadId, catId, reason, invocationId) {
        if (invocationId)
          await project('lifecycle.blocked', () => lifecycle.onClosureBlocked(threadId, catId, reason, invocationId));
      },
      async cleanupPlaceholders() {},
      async notifyDeliveryBatchDone(threadId, chainDone, status, invocationId) {
        await project('lifecycle.settled', () =>
          lifecycle.notifyDeliveryBatchDone(threadId, chainDone, status, invocationId),
        );
      },
    };
  };
  const pluginLifecycleHook = composeStreamingHook();
  queueProcessor.setStreamingHook(pluginLifecycleHook);

  const { LimbTranscriptCatDelivery } = await import('./domains/limb/LimbTranscriptCatDelivery.js');
  const { deliverConnectorMessage: deliverLimbTranscript } = await import(
    './infrastructure/email/deliver-connector-message.js'
  );
  limbTranscriptDelivery = new LimbTranscriptCatDelivery({
    isKnownCat: (catId) => catRegistry.tryGet(catId) !== undefined,
    deliverFn: deliverLimbTranscript,
    deliveryDeps: { delivery: persistedQueueDelivery },
  });
  const { LimbOutboundDeliveryHook } = await import('./domains/limb/LimbOutboundDeliveryHook.js');
  const limbOutboundDelivery = new LimbOutboundDeliveryHook({
    bindingStore: limbEmbodimentBindingStore,
    limbRegistry,
  });

  // holdBallDeps is built before composition finishes, and the route reads these at request time
  // through the object reference, so late binding is safe.
  // Post-commit notification for an already-durable wake. Both effects are best-effort and
  // independent; see managed-wake-admitted-notifier.ts for why the drain must not be sequenced
  // behind the broadcast.
  const wakeQueueEmitter = socketManager;
  const notifyManagedWakeAdmitted = createManagedWakeAdmittedNotifier({
    ...(wakeQueueEmitter
      ? {
          broadcastQueueUpdate: (threadId: string, userId: string) =>
            emitQueueUpdated(wakeQueueEmitter, userId, threadId, invocationQueue.list(threadId, userId), 'enqueued'),
        }
      : {}),
    ...(queueProcessor.requestDrain
      ? { requestDrain: (threadId: string) => queueProcessor.requestDrain?.(threadId) }
      : {}),
    log: { warn: (context, message) => app.log.warn(context, message) },
  });

  const admitManagedWake = createManagedCommandWakeAdmission({
    queue: invocationQueue,
    messageStore,
    notifyAdmitted: notifyManagedWakeAdmitted,
  });
  // Physical embodiment is independent of IM packages and their subscriptions.
  const embodimentOutbound: NonNullable<typeof callbackOpts.outboundHook> = {
    async deliver(threadId, content, catId, _rich, _meta, _origin, triggerMessageId) {
      try {
        await limbOutboundDelivery.deliver(threadId, content, catId as CatId | undefined, triggerMessageId);
      } catch (err) {
        app.log.error({ err, threadId, catId }, 'Physical limb outbound delivery failed');
      }
    },
  };
  queueProcessor.setOutboundHook(embodimentOutbound);
  callbackOpts.outboundHook = embodimentOutbound;
  (messagesOpts as { outboundHook?: typeof embodimentOutbound }).outboundHook = embodimentOutbound;
  queueProcessor.setThreadMetaLookup(deliveryThreadMeta);

  // F167 Phase P: late-bind invokeTrigger into holdBallDeps for wakeWhen command completion.
  // holdBallDeps is defined before invokeTrigger exists, but the route handler reads
  // deps.invokeTrigger at request time (closure over object reference), so late binding is safe.
  if (callbackOpts.holdBallDeps) {
    const holdBallDeps = callbackOpts.holdBallDeps as unknown as Record<string, unknown>;
    // The route has no Queue handle of its own; composition hands it the one admission port.
    holdBallDeps.admitManagedWake = admitManagedWake;
    const { ManagedCommandWakeRecoverySweep } = await import(
      './domains/ball-custody/ManagedCommandWakeRecoverySweep.js'
    );
    const recovery = new ManagedCommandWakeRecoverySweep({
      dynamicTaskStore,
      messageStore,
      socketManager,
      taskRunner: taskRunnerV2,
      invocationRecordStore,
      actionSuccessorLeaseStore,
      admitWake: admitManagedWake,
      isCommandRunnerActive: isManagedWakeRunnerActive,
      ...createManagedCommandWakeCarrierAdapter({
        messageStore,
        invocationRecordStore,
        invocationQueue,
      }),
    });
    managedCommandWakeRecovery = recovery;
    (callbackOpts.holdBallDeps as unknown as Record<string, unknown>).managedCommandWakeRecovery = recovery;
    taskRunnerV2.setManagedCommandWakeRecovery((taskId) => recovery.recordFallbackDue(taskId));

    let managedCommandRecoveryTickInFlight = false;
    const runManagedCommandWakeRecovery = (): void => {
      if (managedCommandRecoveryTickInFlight) return;
      managedCommandRecoveryTickInFlight = true;
      const sweepStarted = performance.now();
      void recovery
        .runOnce()
        .then((stats) => {
          const elapsedMs = performance.now() - sweepStarted;
          if (stats.scanned > 0 || elapsedMs >= 200) {
            app.log.info({ ...stats, elapsedMs }, 'F167 S.1-c managed-command wake recovery sweep');
          }
        })
        .catch((err: unknown) => {
          app.log.warn({ err }, 'F167 S.1-c managed-command wake recovery sweep failed');
        })
        .finally(() => {
          managedCommandRecoveryTickInFlight = false;
        });
    };
    runManagedCommandWakeRecovery();
    managedCommandWakeRecoveryTimer = setInterval(runManagedCommandWakeRecovery, 30_000);
    managedCommandWakeRecoveryTimer.unref();
  }

  // F139 Phase 4b: late-bind invokeTrigger so templates can wake cats

  // F192 OQ-21: late-bind invokeTrigger for manual eval trigger endpoint.
  // eval-hub routes registered at line ~1543 (before invokeTrigger existed);
  // the holder pattern lets `POST /api/eval-domains/:domainId/trigger-now`
  // resolve the live trigger at request time. Without this bind, the route
  // returns 503 instead of waking the eval cat.
  invokeTriggerHolder.current = persistedQueueDelivery;

  // F167 Phase M: late-bind busy checker for pre-fire defer (hold_ball activation).
  // Same thread-busy signal as delivery-batch-done (messages.ts:1822 /
  // When a hold wake fires while the cat is mid-work, the scheduler re-arms the
  // once-task instead of delivering a stale wake ("history replay").
  taskRunnerV2.setBusyChecker((threadId) => invocationTracker.has(threadId) || queueProcessor.isThreadBusy(threadId));

  {
    const deliveryDeps = { delivery: persistedQueueDelivery };
    const waitEventLogModule = await import('./domains/ball-custody/WaitLifecycleEventLog.js');
    const waitEventLog = redisClient
      ? new waitEventLogModule.RedisWaitLifecycleEventLog(redisClient)
      : new waitEventLogModule.MemoryWaitLifecycleEventLog();
    if (runtimeDeploymentContext) {
      const [{ DeploymentWaitLifecycleService }, { DeploymentWaitRecoverySweep }] = await Promise.all([
        import('./domains/runtime-deployment/DeploymentWaitLifecycleService.js'),
        import('./domains/runtime-deployment/DeploymentWaitRecoverySweep.js'),
      ]);
      const deploymentWaitLifecycle = new DeploymentWaitLifecycleService({
        taskStore,
        messageStore,
        handoffProposalStore,
        sessionChainStore,
        authorizationRegistry: registry,
        deliveryDeps,
        eventLog: waitEventLog,
        log: app.log,
        bootId: runtimeDeploymentContext.bootId,
        turnExecutionStore,
        currentObservation: async (outcome) => {
          const deploymentId = outcome.subjectRef.split(':')[2];
          if (!deploymentId) return null;
          return runtimeDeploymentContext.provider.observe({
            deploymentId,
            ...(outcome.deploymentMatch?.kind === 'revision_included' && outcome.deploymentMatch.targetRevision
              ? { targetRevision: outcome.deploymentMatch.targetRevision }
              : {}),
          });
        },
      });
      deploymentWaitLifecycleHolder.current = deploymentWaitLifecycle;
      const deploymentWaitRecovery = new DeploymentWaitRecoverySweep(
        taskStore,
        runtimeDeploymentContext.provider,
        deploymentWaitLifecycle,
        app.log,
      );
      deploymentWaitRecoveryLoop = deploymentWaitRecovery;
      runDeploymentWaitRecovery = async () => {
        const result = await deploymentWaitRecovery.run();
        if (result.checked > 0 || result.recovered > 0) {
          app.log.info({ result }, '[F323] deployment wait recovery sweep completed');
        }
      };
      await runDeploymentWaitRecovery();
      deploymentWaitRecovery.startPeriodic();
    }
  }

  // F139 Phase 3B: Hydrate pack templates from SQLite into TemplateRegistry
  const { isF255PresentLoopBuiltinRef } = await import('./infrastructure/scheduler/f255-template-boundary.js');
  const packDefs = packTemplateStore.listAll();
  let packHydrated = 0;
  for (const def of packDefs) {
    if (isF255PresentLoopBuiltinRef(def.builtinTemplateRef)) {
      app.log.warn(`[api] F255: refused Present Loop pack delegate "${def.templateId}" during hydration`);
      continue;
    }
    const builtin = templateRegistry.get(def.builtinTemplateRef);
    if (builtin) {
      templateRegistry.register({
        templateId: def.templateId,
        label: def.label,
        category: def.category,
        description: def.description,
        subjectKind: def.subjectKind,
        defaultTrigger: def.defaultTrigger,
        paramSchema:
          def.paramSchema as import('./infrastructure/scheduler/templates/types.js').TaskTemplate['paramSchema'],
        createSpec: builtin.createSpec,
      });
      packHydrated++;
    }
  }
  if (packHydrated > 0) app.log.info(`[api] F139: hydrated ${packHydrated} pack template(s)`);

  // F139 Phase 3A: Hydrate dynamic tasks from SQLite before starting
  if (waitTerminationService) {
    const recoveredTerminations = await waitTerminationService.recoverExecutionProjections();
    if (recoveredTerminations > 0) {
      app.log.info({ recoveredTerminations }, '[api] F280: recovered terminal wait execution projections');
    }
  }
  const hydrated = taskRunnerV2.hydrateDynamic(dynamicTaskStore, templateRegistry);
  if (hydrated > 0) app.log.info(`[api] F139: hydrated ${hydrated} dynamic task(s)`);

  // F192 livefix OQ-17: Register daily + weekly eval domain tasks (reads eval-domains/*.yaml, triggers eval cats)
  const { createEvalDomainDailySpec, createEvalDomainWeeklySpec } = await import(
    './infrastructure/harness-eval/domain/eval-domain-daily.js'
  );
  // N-day factory is in its own module (split from eval-domain-daily for file-size limit)
  const { createEvalDomainNDaySpec } = await import('./infrastructure/harness-eval/domain/eval-domain-nday.js');
  const { getOwnerUserId } = await import('./config/cat-config-loader.js');
  // cloud R6 P2 (PR-2) + memory wire-up: mirror the same wired set the
  // eval-hub.ts route computes (Object.keys(verdictGenerators)). Bootstrap-time
  // invariant:
  //   eval:a2a always wired;
  //   eval:capability-wakeup wired iff toolEventLog + skillLoadEventLog exist;
  //   eval:memory wired iff memoryServices.markerQueue exists (always-present in
  //     production but gated for parity with test/edge configs).
  // This gates scheduled daily/weekly invocations' publish instructions on actual runtime support
  // — without this, scheduled eval would tell cat to publish even when no Redis/markers →
  // handler 501 → wasted run. Mirrors the eval-hub.ts route-layer gating.
  const wiredPublishDomains = new Set<EvalDomainId>(['eval:a2a']);
  wiredPublishDomains.add('eval:external-case-closure');
  wiredPublishDomains.add('eval:task-outcome');
  // eval:sop has no runtime dependencies (unlike cw needing toolEventLog or memory
  // needing markerQueue) — unconditionally wired like eval:a2a and eval:task-outcome.
  wiredPublishDomains.add('eval:sop');
  // F245 PR1b: eval:friction provider is unconditionally wired (pure ctor; embedding
  // optional). Mirror task-outcome — unconditional add (must match the verdictGenerators
  // map above, else split-brain: scheduled fire would 501).
  wiredPublishDomains.add('eval:friction');
  // F236 Track-2: eval:anchor-first provider is unconditionally wired (pure ctor,
  // no store deps — wraps in-memory getAnchorTelemetryRollup). Same rationale as friction.
  wiredPublishDomains.add('eval:anchor-first');
  // F253 Phase C: eval:qc provider is unconditionally wired (pure ctor, zero-baseline
  // metrics, no runtime deps). Phase C bootstrap → keep_observe verdicts.
  wiredPublishDomains.add('eval:qc');
  wiredPublishDomains.add('eval:design-gate');
  wiredPublishDomains.add('eval:trajectory-inspector');
  wiredPublishDomains.add('eval:freshness');
  if (toolEventLog && skillLoadEventLog) {
    wiredPublishDomains.add('eval:capability-wakeup');
  }
  if (memoryServices.markerQueue) {
    wiredPublishDomains.add('eval:memory');
  }
  // Direction B (clowder-ai#923 fix): per-domain publish-prereq probe.
  // wiredPublishDomains answers "is the generator registered?" but a stale runtime can
  // have the generator AND lack the sourceRefs validator that current eval cats expect.
  // This probe runs once per (domain, cron fire) — its first call dynamically imports
  // the adapter and caches the result; the cached value answers all subsequent calls.
  // Unknown domains pass through (true) — only domains with a registered probe can fail
  // closed. Adding a domain to the switch is opt-in defense; omitting one is no-op.
  const publishPrereqCache = new Map<string, boolean>();
  const publishPrereqProbe = async (domainId: EvalDomainId): Promise<boolean> => {
    const cached = publishPrereqCache.get(domainId);
    if (cached !== undefined) return cached;
    let ok: boolean;
    try {
      if (domainId === 'eval:a2a') {
        // 砚砚 R1 P1 fix: `isA2aSourceRefs` is exported from `validation.ts`, not from
        // `a2a-generator-adapter.ts` (the adapter imports + calls it but does not re-export).
        // Probing the adapter's namespace would always miss the symbol → probe would mark
        // a healthy runtime as "missing prereq" → eval:a2a skipped forever (P1).
        const mod = await import('./infrastructure/harness-eval/publish-verdict/validation.js');
        // isA2aSourceRefs is the post-fix validator; absence on a stale runtime means
        // the publish flow will throw infra blockers when the cat calls publish_verdict.
        ok = typeof (mod as { isA2aSourceRefs?: unknown }).isA2aSourceRefs === 'function';
      } else {
        ok = true; // Future per-domain probes plug in here.
      }
    } catch {
      ok = false;
    }
    publishPrereqCache.set(domainId, ok);
    return ok;
  };
  const evalScheduleOpts = {
    harnessFeedbackRoot: resolve(repoRoot, 'docs', 'harness-feedback'),
    threadStore,
    defaultUserId: getOwnerUserId(),
    listDynamicTasks: () => dynamicTaskStore.getAll(),
    redis: redisClient ?? undefined,
    wiredPublishDomains,
    publishPrereqProbe,
    triggerStore: redisClient
      ? new (
          await import('./infrastructure/harness-eval/domain/eval-domain-trigger-store.js')
        ).RedisEvalDomainTriggerStore(redisClient)
      : undefined,
  };
  taskRunnerV2.register(createEvalDomainDailySpec(evalScheduleOpts));
  taskRunnerV2.register(createEvalDomainWeeklySpec(evalScheduleOpts));
  // F245 PR2: N-day cadence — eval:friction runs every-3d (not weekly)
  taskRunnerV2.register(createEvalDomainNDaySpec(evalScheduleOpts));

  // F192 Phase I: replay the current F303 cumulative source map at startup and observe
  // later durable YAML revisions through the same dispatcher/receipt plane as weekly cron.
  // A missed/degraded watch is recovered by startup replay and the weekly time fallback.
  const designGateTriggerProvider = designGateEpisodeSourceProvider;
  const evalDomainTriggerStore = evalScheduleOpts.triggerStore;
  if (evalDomainTriggerStore) {
    const { dispatchEvolutionProgramThresholdTrigger } = await import(
      './infrastructure/capability-evolution/program-trigger-bridge.js'
    );
    const { dispatchEvolutionProgramRoundTrigger } = await import(
      './infrastructure/capability-evolution/program-trigger-bridge.js'
    );
    evolutionRoundDispatch = (context) =>
      dispatchEvolutionProgramRoundTrigger({
        harnessFeedbackRoot: evalScheduleOpts.harnessFeedbackRoot,
        programId: context.programId,
        store: evalDomainTriggerStore,
        deliver: schedulerDeliver,
        defaultUserId: evalScheduleOpts.defaultUserId,
        wiredPublishDomains,
      });
    evolutionObservationDispatch = (input) =>
      dispatchEvolutionProgramThresholdTrigger({
        harnessFeedbackRoot: evalScheduleOpts.harnessFeedbackRoot,
        ...input,
        store: evalDomainTriggerStore,
        deliver: schedulerDeliver,
        defaultUserId: evalScheduleOpts.defaultUserId,
        wiredPublishDomains,
      });
  }
  if (designGateTriggerProvider && evalDomainTriggerStore) {
    const { loadDesignGateThresholdDomain, observeDesignGateThresholdTrigger, startDesignGateThresholdObserver } =
      await import('./infrastructure/harness-eval/design-gate/design-gate-threshold-trigger.js');
    const designGateDomain = loadDesignGateThresholdDomain(evalScheduleOpts.harnessFeedbackRoot);
    if (designGateDomain) {
      designGateThresholdObserver = startDesignGateThresholdObserver({
        sourceMapRoot: resolve(evalScheduleOpts.harnessFeedbackRoot, 'design-gate', 'source-maps'),
        observe: () =>
          observeDesignGateThresholdTrigger({
            provider: designGateTriggerProvider,
            domain: designGateDomain,
            store: evalDomainTriggerStore,
            deliver: schedulerDeliver,
            defaultUserId: evalScheduleOpts.defaultUserId,
            wiredPublishDomains,
            threadStore,
            redis: redisClient ?? undefined,
          }),
        logger: {
          info: (details, message) => app.log.info(details, message),
          warn: (details, message) => app.log.warn(details, message),
        },
      });
    } else {
      app.log.info('[api] F192 Phase I: design-gate threshold observer disabled by domain registry');
    }
  }

  // F266: lifecycle reconciliation is Redis-gated. It only appends canonical
  // lifecycle facts; projections stay pure and no Git/GitHub mutation port is wired.
  if (reevalClosureEventLog && redis) {
    const [
      { createReevalClosureTaskSpec, loadReevalClosureSubjects },
      { getEvalCatOverride },
      { ReevalCaseResponsibilityService },
      { ReevalCaseReevaluationService },
      { createReevalCaseTaskQueueAdmission, ReevalCaseTaskDispatcher },
      { resolveUniqueFeatureThreadId },
    ] = await Promise.all([
      import('./infrastructure/harness-eval/reeval-closure-task-spec.js'),
      import('./infrastructure/harness-eval/domain/eval-domain-override.js'),
      import('./infrastructure/harness-eval/reeval-case-responsibility.js'),
      import('./infrastructure/harness-eval/reeval-case-reevaluation.js'),
      import('./infrastructure/harness-eval/reeval-case-task-dispatch.js'),
      import('./routes/feature-thread-resolver.js'),
    ]);
    const f266AdmissionService = actionSuccessorAdmissionService;
    const taskDispatcher = f266AdmissionService
      ? new ReevalCaseTaskDispatcher({
          log: { warn: app.log.warn.bind(app.log) },
          admit: createReevalCaseTaskQueueAdmission(async (request) => {
            if (!socketManager) return { outcome: 'not_admitted' };
            const a2aDeps = {
              socketManager,
              messageStore,
              ...(invocationTracker ? { invocationTracker } : {}),
              ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
              queueProcessor,
              invocationQueue,
              log: app.log,
            };
            // Exact fan-out and action provenance are decided before atomic admission.
            const plan = planA2AFanoutAdmission(
              { invocationQueue },
              {
                targetCats: [request.targetCatId],
                content: request.message.content,
                userId: request.userId,
                ownerAuthProvenance: 'unknown',
                threadId: request.threadId,
                createdAt: request.message.timestamp ?? Date.now(),
                callerCatId: request.callerCatId,
                actionSuccessorFence: request.actionSuccessorFence,
              },
            );
            if (!plan.acceptedTargetCats.includes(request.targetCatId)) {
              return { outcome: 'not_admitted' };
            }
            // INV-I1: one transaction for the carrier Message and its Queue row.
            const admission = await appendA2ASourceWithLedgerAdmission(
              { messageStore, invocationQueue },
              request.message,
              {
                plan,
                ownerAuthProvenance: 'unknown',
                actionSuccessorFence: request.actionSuccessorFence,
              },
            );
            // Queue commit is the durable boundary (INV-I2). Publication only wakes a drain the
            // admitted row already entitles, so its failure must not un-admit the carrier — the
            // old code reported `carrier_delivery_failed` here while the work really was durable.
            try {
              await enqueueA2ATargets(a2aDeps, {
                targetCats: [request.targetCatId],
                content: request.message.content,
                userId: request.userId,
                ownerAuthProvenance: 'unknown',
                threadId: request.threadId,
                triggerMessage: admission.message,
                callerCatId: request.callerCatId,
                actionSuccessorFence: request.actionSuccessorFence,
                preplannedAdmission: plan,
                ...(admission.preAdmittedEntries
                  ? {
                      preAdmittedEntries: admission.preAdmittedEntries,
                      preAdmittedReplayed: admission.preAdmittedReplayed,
                    }
                  : {}),
              });
            } catch (error) {
              app.log.warn(
                {
                  err: error,
                  messageId: admission.message.id,
                  leaseId: request.actionSuccessorFence.leaseId,
                  leaseGeneration: request.actionSuccessorFence.generation,
                },
                'F266 stable-case carrier publication failed after durable admission; the Queue row stands',
              );
            }
            return { outcome: 'admitted', messageId: admission.message.id };
          }),
        })
      : undefined;
    const responsibilityService =
      f266AdmissionService && taskDispatcher
        ? new ReevalCaseResponsibilityService({
            taskStore,
            eventLog: reevalClosureEventLog,
            admissionService: f266AdmissionService,
            taskDispatcher,
            resolveFeatureThreadId: (featureId, ownerUserId) =>
              resolveUniqueFeatureThreadId(threadStore, backlogStore, ownerUserId, featureId, app.log),
            ownerUserId: privateUserId,
          })
        : undefined;
    const reevaluationService =
      f266AdmissionService && taskDispatcher
        ? new ReevalCaseReevaluationService({
            taskStore,
            eventLog: reevalClosureEventLog,
            admissionService: f266AdmissionService,
            taskDispatcher,
            ownerUserId: privateUserId,
          })
        : undefined;
    taskRunnerV2.register(
      createReevalClosureTaskSpec({
        eventLog: reevalClosureEventLog,
        loadSubjects: () =>
          loadReevalClosureSubjects({
            harnessFeedbackRoot: evalHarnessFeedbackRoot,
            eventLog: reevalClosureEventLog,
            ...(f266Cutover.status === 'active' ? { frictionV3Cutover: f266Cutover.rootActivation } : {}),
            resolveAssignedEvalCatId: async (domainId, registryCatId) =>
              (await getEvalCatOverride(redis, domainId))?.catId ?? registryCatId,
          }),
        ...(responsibilityService ? { responsibilityService } : {}),
        ...(reevaluationService ? { reevaluationService } : {}),
        log: { info: app.log.info.bind(app.log), warn: app.log.warn.bind(app.log) },
      }),
    );
    app.log.info('[api] F266: eval verdict closure reconciler registered');
  }

  if (deferredPersonMemoryReceiptStore) {
    const { ensureMemoryOperationsThread } = await import('./domains/memory/MemoryOperationsThread.js');
    taskRunnerV2.register(
      createDeferredPersonMemoryDailyTaskSpec({
        receiptStore: deferredPersonMemoryReceiptStore,
        messageStore,
        ...(writeOpportunityTerminalLedger ? { writeOpportunityTerminalLedger } : {}),
        ...(writeOpportunityDeliveryStore ? { writeOpportunityDeliveryStore } : {}),
        ensureSystemThread: () => ensureMemoryOperationsThread(threadStore, privateUserId),
        routingDispatchPreflight: routingContextRuntime?.dispatchPreflight ?? {
          async preflight(input) {
            return {
              v: 1,
              ownerId: input.ownerId,
              observedAt: Date.now(),
              resolverState: 'degraded',
              targets: input.targetCatIds.map((targetCatId) => ({
                targetCatId,
                disposition: 'warned' as const,
                reasons: [
                  {
                    code: 'routing_context_unavailable',
                    summary: 'Routing context is unavailable; scheduled memory work is parked',
                    sourceRefs: ['routing-context:not-configured'],
                  },
                ],
                alternatives: [],
              })),
            };
          },
        },
        ownerUserId: privateUserId,
      }),
    );
    app.log.info('[api] F276: deferred known-person delta daily clerk registered');
  }

  // F278: completeness scan and duty review share the same durable event log
  // and register before TaskRunnerV2 starts. Clustering is not consulted by
  // either task, so degraded semantic health can never hide an inbox item.
  if (
    pawFeelDispositionReconciler &&
    pawFeelDispositionReadModel &&
    pawFeelBlockerReconciler &&
    pawFeelDutyConfigStore &&
    pawFeelDutyNoticeWatermarkStore &&
    pawFeelDutyReceiptService
  ) {
    taskRunnerV2.register(
      createPawFeelReconciliationTaskSpec({
        reconciler: pawFeelDispositionReconciler,
        blockerReconciler: pawFeelBlockerReconciler,
        log: { info: app.log.info.bind(app.log), warn: app.log.warn.bind(app.log) },
      }),
    );
    taskRunnerV2.register(
      createPawFeelDutyTaskSpec({
        loadUndispositioned: () => pawFeelDispositionReadModel.listUndispositioned(),
        loadDutyConfig: () => pawFeelDutyConfigStore.read(),
        watermarkStore: pawFeelDutyNoticeWatermarkStore,
        receiptReconciler: pawFeelDutyReceiptService,
        ownerUserId: privateUserId,
        inboxHref: 'Workspace → 评估',
        ensureSystemThread: async () => {
          await ensureEvalDomainThreads(
            threadStore,
            [
              {
                domainId: 'eval:friction',
                systemThreadId: 'thread_eval_friction',
                displayName: 'Friction Signal Eval',
              },
            ],
            privateUserId,
          );
        },
      }),
    );
    app.log.info('[api] F278: paw-feel reconciliation and duty schedulers registered');
  }

  // F233 PR4: realtime blocked-task probe. Side effects live here, not in projector/rebuild.
  if (ballCustodyIngest && ballCustodyProjectionStore) {
    const [
      { BallCustodyProbeScheduler },
      { DefaultBallCustodyProbeEvaluator },
      { SchedulerBallCustodyWakeSender },
      { createBallCustodyProbeTaskSpec },
    ] = await Promise.all([
      import('./domains/ball-custody/BallCustodyProbeScheduler.js'),
      import('./domains/ball-custody/BallCustodyProbeEvaluator.js'),
      import('./domains/ball-custody/BallCustodyWakeSender.js'),
      import('./domains/ball-custody/BallCustodyProbeTaskSpec.js'),
    ]);
    const probeIntervalMs = Number.parseInt(process.env.F233_BALL_CUSTODY_PROBE_INTERVAL_MS ?? '', 10);
    const probeScheduler = new BallCustodyProbeScheduler({
      projectionStore: ballCustodyProjectionStore,
      taskStore,
      ballCustody: ballCustodyIngest,
      probeEvaluator: new DefaultBallCustodyProbeEvaluator({ redis }),
      wakeSender: new SchedulerBallCustodyWakeSender({
        deliver: schedulerDeliver,
        readPersistedContent: async (messageId) => (await messageStore.getById(messageId))?.content ?? null,
        defaultUserId: getOwnerUserId(),
        logger: { warn: app.log.warn.bind(app.log) },
      }),
      logger: { warn: app.log.warn.bind(app.log), info: app.log.info.bind(app.log) },
    });
    taskRunnerV2.register(
      createBallCustodyProbeTaskSpec({
        scheduler: probeScheduler,
        ...(Number.isFinite(probeIntervalMs) && probeIntervalMs > 0 ? { intervalMs: probeIntervalMs } : {}),
        log: { warn: app.log.warn.bind(app.log), info: app.log.info.bind(app.log) },
      }),
    );
    app.log.info('[api] F233 PR4: ball-custody probe scheduler registered');
  }

  // F304: the failed F233 Phase C collector is retired. Historical trajectory
  // stores and read routes remain available for Story compatibility.

  // F139: Start unified scheduler (all registered specs)
  taskRunnerV2.start();
  app.log.info(`[api] F139: unified scheduler started (${taskRunnerV2.getRegisteredTasks().join(', ')})`);

  // Graceful shutdown handler: persist Redis before exit
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      app.log.info(`[api] Received ${signal} while shutdown already in progress`);
      return;
    }
    shuttingDown = true;

    let exitCode = 0;
    try {
      app.log.info(`[api] Received ${signal}, shutting down gracefully...`);

      // Log shutdown to audit log FIRST (before any cleanup that might fail)
      try {
        await auditLog.append({
          type: AuditEventTypes.SERVER_SHUTDOWN,
          data: { signal, graceful: true },
        });
      } catch {
        // Audit log write failed, but continue with shutdown
      }

      // Trigger Redis BGSAVE to persist in-memory data before exit
      if (redisClient) {
        try {
          app.log.info('[api] Triggering Redis BGSAVE before shutdown...');
          await redisClient.bgsave();
          // Give Redis a moment to start the background save
          await new Promise((r) => setTimeout(r, 500));
          app.log.info('[api] Redis BGSAVE triggered');
        } catch (err) {
          app.log.error(`[api] Redis BGSAVE failed: ${String(err)}`);
        }
      }

      taskRunnerV2.stop();

      // Stop event bus subscribers
      cloudConversations.stop();
      accountBindingSubscriber.unsubscribe();
      pushConfigUnsub?.();
      pushConfigUnsub = null;

      // Stop preview gateway (F120)
      try {
        await previewGateway.stop();
      } catch (err) {
        app.log.error(`[api] PreviewGateway stop failed: ${String(err)}`);
      }

      // Close WebSocket connections
      try {
        socketManager?.close();
      } catch (err) {
        exitCode = 1;
        app.log.error(`[api] SocketManager close failed: ${String(err)}`);
      }

      // F153 Phase E L3: Stop burn-rate monitor
      burnRateMonitor?.stop();

      // F152: Flush and shutdown OTel SDK before closing server
      try {
        await telemetryHandle.shutdown();
      } catch (err) {
        app.log.error(`[api] OTel shutdown failed: ${String(err)}`);
      }

      // Close Fastify server
      await app.close();

      try {
        await apiInstanceLease?.release();
      } catch (err) {
        exitCode = 1;
        app.log.error(`[api] API namespace lease release failed: ${String(err)}`);
      }

      if (runtimeDeploymentContext && exitCode === 0) {
        try {
          await runtimeDeploymentContext.ledger.completeCleanExit({
            deploymentId: runtimeDeploymentContext.deploymentId,
            bootId: runtimeDeploymentContext.bootId,
            signal,
          });
        } catch (err) {
          app.log.error(`[F323] Runtime clean-exit evidence unavailable: ${String(err)}`);
        }
      }

      app.log.info('[api] Shutdown complete');
    } catch (err) {
      exitCode = 1;
      app.log.error(`[api] Shutdown failed: ${String(err)}`);
    } finally {
      if (forcedLeaseLossExitTimer) {
        clearTimeout(forcedLeaseLossExitTimer);
        forcedLeaseLossExitTimer = null;
      }
      process.exit(exitCode);
    }
  };
  shutdownForLeaseLoss = shutdown;

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  recordRuntimeStartupFailure = null;
}

main().catch(async (err) => {
  try {
    await recordRuntimeStartupFailure?.(err instanceof Error ? err.message : String(err));
  } catch (ledgerError) {
    console.error('[api] Failed to persist runtime startup failure:', ledgerError);
  }
  console.error('[api] Fatal error:', err);
  process.exit(1);
});
