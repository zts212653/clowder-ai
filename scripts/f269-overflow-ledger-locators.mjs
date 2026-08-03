export const KNOWN_PRODUCER_LOCATORS = Object.freeze([
  {
    id: 'producer:web:reply-preview-storage',
    path: 'packages/web/src/hooks/useSendMessage.ts',
    needles: ['capturedReplyTarget.content.slice(0, PREVIEW_MAX)'],
  },
  {
    id: 'producer:web:story-session-id',
    path: 'packages/web/src/app/story/[storyId]/page.tsx',
    needles: ['sessionId.slice(0, 24)'],
  },
  {
    id: 'producer:web:story-export-id',
    path: 'packages/web/src/app/story/[storyId]/public/page.tsx',
    needles: ['pack.manifest.exportId.slice(0, 8)'],
  },
  {
    id: 'producer:web:cross-post-direction-id',
    path: 'packages/web/src/lib/parse-direction.ts',
    needles: ["sourceThreadId.replace(/^thread_/, '').slice(0, 8)"],
  },
  {
    id: 'producer:web:story-chapter-invocation-id',
    path: 'packages/web/src/lib/story-player/chapters.ts',
    needles: ['event.invocationId.slice(0, 8)'],
  },
  {
    id: 'producer:web:cross-post-source-id',
    path: 'packages/web/src/components/ChatMessage.tsx',
    needles: ["sourceId.replace(/^thread_/, '').slice(0, 8)"],
  },
  {
    id: 'producer:web:study-thread-id',
    path: 'packages/web/src/components/signals/StudyTimeline.tsx',
    needles: ['t.threadId.slice(0, 12)'],
  },
  {
    id: 'producer:web:podcast-id',
    path: 'packages/web/src/components/signals/PodcastPlayer.tsx',
    needles: ['p.id.slice(0, 8)'],
  },
  {
    id: 'producer:web:external-review-sha',
    path: 'packages/web/src/components/community/ExternalReviewStatus.tsx',
    needles: ['sha?.slice(0, 7)'],
  },
  {
    id: 'producer:web:signal-note-tooltip',
    path: 'packages/web/src/components/signals/SignalArticleList.tsx',
    needles: ['article.note.slice(0, 80)'],
  },
  {
    id: 'producer:web:story-cinematic-text',
    path: 'packages/web/src/components/story-player/ReplayEventBubble.tsx',
    needles: ['return content.slice(0, visibleChars);'],
  },
  {
    id: 'producer:web:story-annotation-tooltip',
    path: 'packages/web/src/components/story-player/AnnotationOverlay.tsx',
    needles: ['a.content.slice(0, 40)'],
  },
  {
    id: 'producer:web:message-navigator-preview',
    path: 'packages/web/src/components/MessageNavigator.tsx',
    needles: ['content.slice(0, maxLen)'],
  },
  {
    id: 'producer:web:thinking-preview',
    path: 'packages/web/src/components/ThinkingContent.tsx',
    needles: ['content.slice(0, previewLength)'],
  },
  {
    id: 'producer:web:cli-output-summary',
    path: 'packages/web/src/components/cli-output/CliOutputBlock.tsx',
    needles: ['preview.slice(0, TEXT_PREVIEW_MAX_CHARS)'],
  },
  {
    id: 'producer:web:cli-tool-argument',
    path: 'packages/web/src/components/cli-output/toCliEvents.ts',
    needles: ['val.slice(0, max - 3)'],
  },
  {
    id: 'producer:web:reply-preview-bar',
    path: 'packages/web/src/components/ReplyPreviewBar.tsx',
    needles: ['content.slice(0, 80)'],
  },
  {
    id: 'producer:web:split-pane-message',
    path: 'packages/web/src/components/SplitPaneCell.tsx',
    needles: ['msg.content.slice(0, 120)'],
  },
  {
    id: 'producer:web:collection-anchor-label',
    path: 'packages/web/src/components/memory/CollectionGraphModel.ts',
    needles: ['withoutDocPrefix.slice(0, 10)'],
  },
  {
    id: 'producer:web:collection-node-label',
    path: 'packages/web/src/components/memory/CollectionGraphModel.ts',
    needles: ["chars.slice(0, maxChars - 1).join('')"],
  },
  {
    id: 'producer:web:collection-updated-date',
    path: 'packages/web/src/components/memory/CollectionCatalog.tsx',
    needles: ['doc.updatedAt.slice(0, 10)'],
  },
  {
    id: 'producer:web:study-local-date-key',
    path: 'packages/web/src/components/signals/StudyTimeline.tsx',
    needles: ['return iso.slice(0, 10);'],
  },
  {
    id: 'producer:web:tool-usage-day-label',
    path: 'packages/web/src/components/HubToolUsageTab.tsx',
    needles: ['day.date.slice(5)'],
  },
  {
    id: 'producer:web:world-event-time',
    path: 'packages/web/src/components/workspace/WorldPanel.tsx',
    needles: ['ev.createdAt.slice(11, 19)'],
  },
  {
    id: 'producer:web:trajectory-commit-sha',
    path: 'packages/web/src/components/workspace/trajectory/TrajectoryCard.tsx',
    needles: ['snap?.headCommitSha?.slice(0, 7)'],
  },
  {
    id: 'producer:web:event-cat-initial',
    path: 'packages/web/src/components/event-memory/event-timeline-cards.tsx',
    needles: ['event.cat.slice(0, 1).toUpperCase()'],
  },
  {
    id: 'producer:web:auto-generated-cat-slug',
    path: 'packages/web/src/components/hub-cat-editor.model.ts',
    needles: ['.slice(0, 40);'],
  },
  {
    id: 'producer:web:cli-diagnostics-id',
    path: 'packages/web/src/components/CliDiagnosticsPanel.tsx',
    needles: ['s.slice(0, head)', 's.slice(-tail)'],
  },
  {
    id: 'producer:web:runtime-session-id',
    path: 'packages/web/src/components/runtime-sessions/external-runtime-session-format.ts',
    needles: ['id.slice(0, 11)', 'id.slice(-8)'],
  },
  {
    id: 'producer:web:status-id',
    path: 'packages/web/src/components/status-helpers.ts',
    needles: ['id.slice(0, len)'],
  },
  {
    id: 'producer:web:thread-project-name',
    path: 'packages/web/src/components/ThreadIndicator.tsx',
    needles: ['name.slice(-(maxLen - 1))'],
  },
  {
    id: 'producer:web:permission-external-chat-id',
    path: 'packages/web/src/components/HubPermissionsTab.tsx',
    needles: ['g.externalChatId.slice(-8)'],
  },
  {
    id: 'producer:web:visible-cafe-thread-id',
    path: 'packages/web/src/components/visible-cafe/StarCard.tsx',
    needles: ['card.threadId.slice(-8)'],
  },
  {
    id: 'producer:web:visible-cafe-star-label',
    path: 'packages/web/src/components/visible-cafe/StarWindow.tsx',
    needles: ['light.threadId.slice(-6)'],
  },
  {
    id: 'producer:web:governance-project-path',
    path: 'packages/web/src/components/HubGovernanceTab.tsx',
    needles: ["slice(-2).join('/')"],
  },
  {
    id: 'producer:web:resolution-card-option',
    path: 'packages/web/src/components/mission-control/ResolutionQueue.tsx',
    needles: ['c.id.slice(0, 8)', 'c.goal.slice(0, 50)'],
  },
  {
    id: 'producer:web:resolution-list-card-id',
    path: 'packages/web/src/components/mission-control/ResolutionQueue.tsx',
    needles: ['item.cardId.slice(0, 8)'],
  },
  {
    id: 'producer:web:risk-card-id',
    path: 'packages/web/src/components/mission-control/RiskPanel.tsx',
    needles: ['card.id.slice(0, 8)'],
  },
  {
    id: 'producer:web:metadata-session-id',
    path: 'packages/web/src/components/MetadataBadge.tsx',
    needles: ['metadata.sessionId.slice(0, 12)'],
  },
  {
    id: 'producer:web:schedule-thread-id',
    path: 'packages/web/src/components/workspace/SchedulePanel.tsx',
    needles: ['currentThreadId.slice(0, 12)'],
  },
  {
    id: 'producer:web:agent-pane-invocation-id',
    path: 'packages/web/src/components/workspace/AgentPaneList.tsx',
    needles: ['p.invocationId.slice(0, 8)'],
  },
  {
    id: 'producer:web:slice-ladder-card-id',
    path: 'packages/web/src/components/mission-control/SliceLadder.tsx',
    needles: ['slice.cardIds.map((id) => id.slice(0, 8))'],
  },
  {
    id: 'producer:api:callback-message-preview',
    path: 'packages/api/src/routes/callback-anchor-helpers.ts',
    needles: [
      'opts.keywordTerms && opts.keywordTerms.length > 0',
      'drillDown: messageDrillDown(item.id, opts.agentKeyCatId)',
    ],
  },
  {
    id: 'producer:api:callback-mention-preview',
    path: 'packages/api/src/routes/callback-anchor-helpers.ts',
    needles: ['const { preview, truncated } = truncateHeadTail(item.content);', 'requiresDrill: truncated'],
  },
  {
    id: 'producer:api:callback-task-why-preview',
    path: 'packages/api/src/routes/callback-anchor-helpers.ts',
    needles: ['truncateHead(why)', 'whyTruncated: truncated'],
  },
]);
