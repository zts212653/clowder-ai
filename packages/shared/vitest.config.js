import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only vitest-runner tests. Most shared tests use node:test (import from 'node:test')
    // and run separately via `node --test`. Vitest tests import from 'vitest'.
    include: [
      'test/concierge-config.test.js',
      'test/pet-skin-projection.test.js',
      'src/__tests__/capability-tips.test.ts',
      'src/__tests__/action-successor-types.test.ts',
      'src/__tests__/cross-thread-coordination.test.ts',
      'src/__tests__/auto-dream.test.ts',
      'src/__tests__/human-disposition-feedback.test.ts',
      'src/__tests__/wait-termination.test.ts',
      'src/__tests__/proactive-memory-opportunity.test.ts',
      'src/__tests__/memory-write-opportunity.test.ts',
      'src/__tests__/subject-key.test.ts',
      'src/__tests__/cli-effort.test.ts',
      'src/__tests__/codex-speed.test.ts',
      'src/__tests__/dispatch-proposal-types.test.ts',
      'src/__tests__/approval-hub-types.test.ts',
      'src/__tests__/approval-producer-catalog.test.ts',
      'src/__tests__/explicit-stop-intent.test.ts',
      'src/__tests__/preview-gateway.test.ts',
      'src/__tests__/person-memory-contract.test.ts',
      'src/__tests__/person-memory-rich-card.test.ts',
      'src/__tests__/eval-metric-ref.test.ts',
      'src/__tests__/load-dossier-profiles.test.ts',
      'src/__tests__/parse-dossier-profiles.test.ts',
      'src/__tests__/profile-frontmatter-parser.test.ts',
      'src/__tests__/scanner-discovery-pure.test.ts',
      'src/__tests__/recall-outcome.test.ts',
      'src/__tests__/capability-tip-privacy.test.ts',
      'src/__tests__/capability-tip-telemetry.test.ts',
      'src/__tests__/paw-feel-disposition-contract.test.ts',
      'src/__tests__/memory-cue.test.ts',
      'src/__tests__/context-attachment.test.ts',
      'test/message-bundle-schema.test.ts',
      'test/markdown-readable-text.test.ts',
    ],
  },
});
