/** Existing F190 console border policy, enforced once by ESLint instead of 50 product test registrations. */
const DIVIDER_SCOPE = new Set([
  'memory/MemoryNav.tsx',
  'signals/SignalNav.tsx',
  'mission-control/MissionControlPage.tsx',
  'settings/primitives/SettingsRow.tsx',
  'settings/primitives/SettingsCollapsibleCard.tsx',
  'settings/capability-settings-ui.tsx',
  'UnifiedAuthModal.tsx',
  'PushSettingsPanel.tsx',
  'ThreadExecutionBar.tsx',
  'ParallelStatusBar.tsx',
  'audit/AuditExplorerPanel.tsx',
  'mission-control/WorkflowSopPanel.tsx',
  'mission-control/FeatureRowList.tsx',
  'workspace/WorldPanel.tsx',
  'PlanBoardPanel.tsx',
  'workspace/ConsolePanel.tsx',
  'workspace/BrowserToolbar.tsx',
  'workspace/BrowserPanel.tsx',
  'workspace/DiffViewer.tsx',
  'rich/DiffBlock.tsx',
  'mission-control/ExternalProjectTab.tsx',
  'mission-control/SliceLadder.tsx',
  'mission-control/ThreadSituationPanel.tsx',
  'memory/CollectionGraphParts.tsx',
  'memory/RecallFeed.tsx',
  'memory/ToolUsageMetricsPanel.tsx',
  'ThreadSidebar/ThreadSidebar.tsx',
  'ThreadSidebar/DirectoryBrowser.tsx',
]);

const CARD_SCOPE = new Set([
  'mission-control/CreateIntentCardForm.tsx',
  'mission-control/IntentCardDetail.tsx',
  'mission-control/ImportProjectModal.tsx',
  'mission-control/SuggestionDecisionPanel.tsx',
  'mission-control/GovernanceHealth.tsx',
  'mission-control/NeedAuditFrame.tsx',
  'mission-control/DispatchProgress.tsx',
  'mission-control/ResolutionQueue.tsx',
  'mission-control/RefluxCapture.tsx',
  'mission-control/RiskPanel.tsx',
  'mission-control/DependencyGraphTab.tsx',
  'mission-control/TranslationMatrix.tsx',
  'mission-control/FeatureBirdEyePanel.tsx',
  'mission-control/ThreadSituationPanel.tsx',
  'mission-control/WorkflowSopPanel.tsx',
  'mission-control/SliceLadder.tsx',
  'mission-control/ExternalProjectTab.tsx',
  'mission-control/QuickCreateForm.tsx',
  'mission-control/FeatureRowList.tsx',
  'mission-control/SuggestionDrawer.tsx',
  'mission-control/MissionControlCard.tsx',
  'mission-control/MissionControlPage.tsx',
]);

const rawDivider = /\bborder-[tbrl]\s+border-\[var\(--console-border-soft\)\]/;
const rawCard = /\bborder\s+border-\[var\(--console-border-soft\)\]/;

module.exports = {
  // Let the rule's scope guard detect renamed/deleted files without copying the policy registry.
  scopedComponentPaths: [...new Set([...DIVIDER_SCOPE, ...CARD_SCOPE])],
  meta: {
    type: 'suggestion',
    docs: { description: 'Use semantic console dividers and card surfaces in the existing F190 scope.' },
    schema: [],
    messages: {
      divider: 'Use console-divider-* instead of a raw console-border-soft divider.',
      card: 'Use the shared console card surface instead of a raw console-border-soft container border.',
    },
  },
  create(context) {
    const filename = context.getFilename().replaceAll('\\', '/');
    const relative = filename.split('/src/components/').at(-1);
    const divider = DIVIDER_SCOPE.has(relative);
    const card = CARD_SCOPE.has(relative);
    if (!divider && !card) return {};

    function checkDivider(node, value) {
      if (divider && typeof value === 'string' && rawDivider.test(value)) {
        context.report({ node, messageId: 'divider' });
      }
    }

    return {
      Literal(node) {
        checkDivider(node, node.value);
        if (
          card &&
          node.parent?.type === 'JSXAttribute' &&
          node.parent.name.name === 'className' &&
          typeof node.value === 'string' &&
          rawCard.test(node.value)
        ) {
          context.report({ node, messageId: 'card' });
        }
      },
      TemplateElement(node) {
        checkDivider(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};
