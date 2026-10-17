import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type TestContext } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionHostBridge } from '../../src/domains/concierge/live/CompanionHostBridge.js';
import type {
  LivePresentationObservation,
  LivePresentationReply,
} from '../../src/domains/concierge/live/live-presentation-observations.js';
import { companionCommandValidator } from '../../src/domains/plugin/desktop-window-runtime/admission.js';
import type { DesktopWindowLaunch } from '../../src/domains/plugin/desktop-window-runtime/types.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../../src/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../../src/domains/plugin/runtime-composition.js';
import { sessionAuthPlugin, sessionRoute } from '../../src/infrastructure/session-auth.js';
import {
  companionDecisionWireResponse,
  readCompanionDecisionProjection,
} from '../../src/routes/companion-decision-read-service.js';
import { desktopWindowManifest, windowHtml } from '../f317-window.fixture.js';
import { approval } from '../growing/unified-attention-fixtures.js';
import { staticEditorFixture } from '../plugin-static-editor.fixture.js';

export async function modernCompanionInstallFixture(
  t: TestContext,
  version:
    | '0.1.0-alpha.13'
    | '0.1.0-alpha.14'
    | '0.1.0-alpha.15'
    | '0.1.0-alpha.19'
    | '0.1.0-alpha.20'
    | '0.1.0-alpha.24'
    | '0.1.0-alpha.25',
  alterArchive?: (bytes: Buffer) => Buffer,
  observePresentation?: (
    receipt: LivePresentationObservation,
    verifyHost: () => Promise<boolean>,
  ) => Promise<LivePresentationReply>,
) {
  const contract =
    version === '0.1.0-alpha.25'
      ? '0.1.0-beta.28'
      : version === '0.1.0-alpha.24'
        ? '0.1.0-beta.27'
        : version === '0.1.0-alpha.15' || version === '0.1.0-alpha.19' || version === '0.1.0-alpha.20'
          ? '0.1.0-beta.24'
          : version === '0.1.0-alpha.14'
            ? '0.1.0-beta.23'
            : '0.1.0-beta.21';
  const f = await staticEditorFixture(
    { ...desktopWindowManifest(windowHtml, '1.3.0'), pluginId: 'official.companion', version },
    windowHtml,
  );
  const actualArchive =
    version === '0.1.0-alpha.25'
      ? process.env.F317_VERIFIED_LETTER_ARCHIVE
      : version === '0.1.0-alpha.24'
        ? process.env.F317_VERIFIED_PRESENTATION_ARCHIVE
        : version === '0.1.0-alpha.20'
          ? process.env.F317_VERIFIED_LIVE_TAIL_ARCHIVE
          : version === '0.1.0-alpha.19'
            ? process.env.F317_VERIFIED_SUBTITLE_RETURN_ARCHIVE
            : version === '0.1.0-alpha.15'
              ? process.env.F317_VERIFIED_UNIFIED_ARCHIVE
              : version === '0.1.0-alpha.14'
                ? process.env.F317_VERIFIED_MODERN_ARCHIVE
                : undefined;
  const originalBytes = actualArchive ? await readFile(actualArchive) : f.bytes;
  const bytes = alterArchive ? alterArchive(originalBytes) : originalBytes;
  const entry = actualArchive
    ? {
        ...OFFICIAL_PLUGIN_CATALOG.find((row) => row.pluginId === 'official.companion')!,
        version,
        packageDigest: `sha512-${createHash('sha512').update(originalBytes).digest('base64')}`,
        archiveUrl: `https://registry.npmjs.org/@clowder-ai/companion/-/companion-${version}.tgz`,
      }
    : { ...f.entry, effectiveGrants: ['windows.create' as const] };
  const owner = 'modern-composition-owner';
  const priorOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = owner;
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: owner });
  const config = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'composition-selected' };
  app.get('/api/concierge/config', async () => ({
    status: 'available',
    config,
    selectedCompanionStatus: 'available',
    companions: [{ catProfileId: config.dutyCatProfileId, displayName: 'selected', available: true }],
  }));
  let needsMeAvailable = true;
  app.get('/api/approval-hub/pending', async () => ({
    // This complete-count fixture has an unanchored canonical F128 proposal.
    // F221 needs a live original-card proof and would honestly withhold exact counts here.
    items: [{ ...approval('composition', 'F128'), ownerUserId: owner }],
    coverage: { state: 'complete' },
  }));
  app.get('/api/entrusted-work/needs-me', async (_request, reply) =>
    needsMeAvailable
      ? { ownerReads: [], coverage: { state: 'complete' } }
      : reply.code(503).send({ error: 'fixture source unavailable' }),
  );
  app.get('/api/concierge/work/decisions', async (request, reply) => {
    const query = request.query as { view?: 'unified'; offset?: string; limit?: string };
    const result = companionDecisionWireResponse(
      await readCompanionDecisionProjection(app, owner, {
        offset: Number(query.offset ?? 0),
        limit: Number(query.limit ?? 20),
      }),
      query.view,
    );
    return reply.code(result.statusCode).send(result.body);
  });
  const messages = new MessageStore();
  const saved = messages.append({
    userId: owner,
    threadId: 'home',
    from: { kind: 'user', userId: owner },
    content: 'preserved',
    mentions: [],
    timestamp: 1,
  });
  let launch: DesktopWindowLaunch | undefined;
  let closes = 0;
  let bridgeContract: string | undefined;
  let denyClose = false;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: messages,
    // Normal deterministic tests use an explicitly trusted fixture catalog. The
    // opt-in registry journey uses the production digest catalog without overrides.
    ...(actualArchive ? {} : { companionArchives: [{ version, packageDigest: f.entry.packageDigest, contract }] }),
    createCompanionBridge: (context) => {
      bridgeContract = context.companionContract;
      return new CompanionHostBridge({
        ...context,
        app,
        ownerUserId: owner,
        messages,
        verifyConversationThread: async (threadId) => threadId === 'home',
        origin: 'http://localhost:5102',
        openConversation: async () => true,
        ...(observePresentation ? { observePresentation } : {}),
      });
    },
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        return {
          poll: async () => 'visible',
          show: async () => {},
          close: async () => {
            closes++;
            if (denyClose) throw new Error('physical cleanup not confirmed');
          },
        };
      },
    },
  });
  t.after(async () => {
    denyClose = false;
    await runtime.shutdown();
    await app.close();
    await f.cleanup();
    if (priorOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = priorOwner;
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [entry],
    fetchArchive: async () => bytes,
  });
  const installed = await installer.install(entry.catalogId, entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.ok(launch?.request);
  assert.equal(launch.companionContract, contract);
  assert.equal(bridgeContract, contract);
  assert.equal(companionCommandValidator(contract)({ kind: 'settings.read' }), version !== '0.1.0-alpha.13');
  return {
    runtime,
    app,
    actualArchive,
    launch,
    config,
    saved,
    messages,
    instanceId: installed.pluginInstanceId,
    closes: () => closes,
    denyClose: () => {
      denyClose = true;
    },
    failNeedsMe: () => {
      needsMeAvailable = false;
    },
  };
}
