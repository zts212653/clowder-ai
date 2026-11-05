import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploymentDefaults } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { ENV_VARS } from '../../dist/config/env-registry.js';
import { AgentKeyRegistry } from '../../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { materializeAgyNativeAgentFile } from '../../dist/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js';
import { CAT_CAFE_GITHUB_ROUTING_INSTRUCTIONS } from '../../dist/domains/cats/services/agents/providers/codex-app-approval-routing.js';
import { buildKimiL0AgentFileContent } from '../../dist/domains/cats/services/agents/providers/kimi-l0-agent-file.js';
import { DotConnectionService } from '../../dist/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../../dist/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotDispatchStore } from '../../dist/domains/cats/services/cloud-bridge/dot/DotDispatchStore.js';
import { DotReturnService } from '../../dist/domains/cats/services/cloud-bridge/dot/DotReturnService.js';
import { QUEST_TASKS } from '../../dist/domains/cats/services/first-run-quest/quest-blocks.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { buildAbstractiveSummaryPrompt } from '../../dist/domains/memory/abstractive-summary-prompt.js';
import { LEGACY_BUNDLED_MANIFESTS } from '../../dist/domains/plugin/legacy-bundled-manifests.js';
import { DEFAULT_SIGNAL_NOTIFICATIONS } from '../../dist/domains/signals/config/notifications-loader.js';
import { SignalInAppNotificationService } from '../../dist/domains/signals/services/in-app-notification.js';
import { renderDailyDigestEmail } from '../../dist/domains/signals/templates/daily-digest.js';
import { AntigravityMarketplaceAdapter } from '../../dist/marketplace/adapters/antigravity-adapter.js';
import { registerDotMcpRoutes } from '../../dist/routes/chatgpt-dot-mcp-routes.js';
import { withVerdictGhGuardEnv } from '../../dist/utils/cli-spawn.js';

const dotHome = mkdtempSync(join(tmpdir(), 'deployment-dot-display-'));
const app = Fastify();
let dotServerInfo;
try {
  const unexpectedWrite = async () => {
    throw new Error('Display probe must not publish or send a webhook');
  };
  const connection = new DotConnectionService({
    keys: new AgentKeyRegistry(),
    store: new DotConnectionStore(join(dotHome, 'connection.json')),
    authority: async () => ({ ownerUserId: 'fixture', pluginInstanceId: 'fixture-dot' }),
    ensureIdentity: async () => {},
    sendWebhook: unexpectedWrite,
  });
  const setup = await connection.begin('fixture');
  const returns = new DotReturnService({
    connection,
    dispatches: new DotDispatchStore(join(dotHome, 'events')),
    messages: new MessageStore(),
    threads: new ThreadStore(),
    postReply: unexpectedWrite,
  });
  registerDotMcpRoutes(app, { connection, returns, publishImage: unexpectedWrite });
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/chatgpt-dot/mcp',
    headers: { authorization: `Bearer ${setup.credentialSecret}` },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
  });
  if (response.statusCode !== 200) throw new Error(response.payload);
  dotServerInfo = response.json().result.serverInfo;
} finally {
  await app.close();
  rmSync(dotHome, { recursive: true, force: true });
}

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
    dotServerInfo,
    repository: ENV_VARS.find((entry) => entry.name === 'CAT_CAFE_REPO_FULL_NAME').defaultValue,
    guardRepository: withVerdictGhGuardEnv({}).CAT_CAFE_VERDICT_REPO_FULL_NAME,
    summary: buildAbstractiveSummaryPrompt(),
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
