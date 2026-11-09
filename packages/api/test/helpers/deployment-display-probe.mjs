import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentDefaults } from '@cat-cafe/shared';
import { parse } from 'yaml';
import { ENV_VARS } from '../../dist/config/env-registry.js';
import { materializeAgyNativeAgentFile } from '../../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js';
import { CAT_CAFE_GITHUB_ROUTING_INSTRUCTIONS } from '../../dist/domains/cats/services/agents/providers/codex-app-approval-routing.js';
import { buildKimiL0AgentFileContent } from '../../dist/domains/cats/services/agents/providers/kimi-l0-agent-file.js';
import { QUEST_TASKS } from '../../dist/domains/cats/services/first-run-quest/quest-blocks.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { buildAbstractiveSummaryPrompt } from '../../dist/domains/memory/abstractive-summary-prompt.js';
import { LEGACY_BUNDLED_MANIFESTS } from '../../dist/domains/plugin/legacy-bundled-manifests.js';
import { DEFAULT_SIGNAL_NOTIFICATIONS } from '../../dist/domains/signals/config/notifications-loader.js';
import { SignalInAppNotificationService } from '../../dist/domains/signals/services/in-app-notification.js';
import { renderDailyDigestEmail } from '../../dist/domains/signals/templates/daily-digest.js';
import { AntigravityMarketplaceAdapter } from '../../dist/marketplace/adapters/antigravity-adapter.js';
import { withVerdictGhGuardEnv } from '../../dist/utils/cli-spawn.js';

const published = [];
const fixtureHome = mkdtempSync(join(tmpdir(), 'deployment-native-display-'));
let agy;
try {
  const file = materializeAgyNativeAgentFile({
    profileHome: fixtureHome,
    catId: 'fixture',
    systemPrompt: '# Identity\nFixture identity',
  });
  agy = readFileSync(file.filePath, 'utf8');
} finally {
  rmSync(fixtureHome, { recursive: true, force: true });
}
const kimi = buildKimiL0AgentFileContent({ catId: 'fixture', l0: 'Fixture identity' });
delete process.env.CAT_CAFE_VERDICT_REPO_FULL_NAME;
delete process.env.CAT_CAFE_REPO_FULL_NAME;
const service = new SignalInAppNotificationService({
  config: DEFAULT_SIGNAL_NOTIFICATIONS,
  sink: { publish: async (event) => published.push(event) },
});
await service.publishDailyDigest({ date: '2026-10-21', articles: [] });
const marketplace = new AntigravityMarketplaceAdapter({
  catalogLoader: async () => [
    {
      id: 'fixture',
      name: 'Fixture',
      description: 'Fixture',
      trustLevel: 'official',
      publisher: 'fixture',
      resolver: 'fixture',
    },
  ],
});
process.stdout.write(
  JSON.stringify({
    brand: deploymentDefaults.brand,
    repository: ENV_VARS.find((entry) => entry.name === 'CAT_CAFE_REPO_FULL_NAME').defaultValue,
    guardRepository: withVerdictGhGuardEnv({}).CAT_CAFE_VERDICT_REPO_FULL_NAME,
    quest: QUEST_TASKS.map((task) => task.label),
    routing: CAT_CAFE_GITHUB_ROUTING_INSTRUCTIONS,
    manifest: LEGACY_BUNDLED_MANIFESTS[0].description,
    from: DEFAULT_SIGNAL_NOTIFICATIONS.notifications.email.from,
    email: renderDailyDigestEmail({ date: '2026-10-21', articles: [] }),
    inApp: published[0].content,
    marketplace: (await marketplace.buildInstallPlan('fixture')).manualSteps,
    nativeDescriptions: [kimi, agy].map((text) => parse(text.split('---')[1]).description),
  }),
);
