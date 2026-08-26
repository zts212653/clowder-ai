#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readPersonalChromeConversationAuthorizations } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import { LiveGateNotObservedError, verifyBoundDelivery } from './f247-personal-chrome-live-contract.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const monorepoRoot = resolve(apiRoot, '../..');

function projectRootFromEnvironment(env) {
  return env.CAT_CAFE_CONFIG_ROOT?.trim() || monorepoRoot;
}

function installedBindingPath(env) {
  return resolve(
    projectRootFromEnvironment(env),
    '.cat-cafe',
    'plugin-host',
    'personal-chrome-host',
    'conversation-binding.json',
  );
}

async function createInstalledAdapter(env) {
  const { RefreshablePersonalChromeHostAdapter } = await import(
    '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js'
  );
  const pairingRecordPath = resolve(
    projectRootFromEnvironment(env),
    '.cat-cafe',
    'plugin-host',
    'personal-chrome-host',
    'pairing.json',
  );
  return new RefreshablePersonalChromeHostAdapter({
    pairingRecordPath,
    env: {},
    logger: { info: () => undefined, warn: () => undefined },
  });
}

async function requireInstalledAuthorization(readConversationAuthorizations, env, conversationId) {
  try {
    const collection = await (readConversationAuthorizations?.() ??
      readPersonalChromeConversationAuthorizations(installedBindingPath(env)));
    if (conversationId) {
      const authorization = collection.conversations.find((entry) => entry.conversationId === conversationId);
      if (!authorization) {
        throw new LiveGateNotObservedError(
          'CONVERSATION_NOT_AUTHORIZED',
          'the exact requested ChatGPT conversation is not authorized',
        );
      }
      return authorization;
    }
    if (collection.conversations.length === 1) return collection.conversations[0];
    if (collection.conversations.length > 1) {
      throw new LiveGateNotObservedError(
        'CONVERSATION_REQUIRED',
        'select one exact authorized ChatGPT conversation for the live gate',
      );
    }
    throw new LiveGateNotObservedError('NEEDS_BINDING', 'authorize at least one ChatGPT conversation');
  } catch (error) {
    if (error?.code === 'NEEDS_AUTHORIZATION') {
      throw new LiveGateNotObservedError(
        'NEEDS_BINDING',
        'open the target ChatGPT conversation and click the extension action “授权此会话” once',
      );
    }
    throw error;
  }
}

export async function runPersonalChromeInPlaceLiveGate(options = {}) {
  if (Object.hasOwn(options, 'nonce') || Object.hasOwn(options, 'text') || Object.hasOwn(options, 'message')) {
    throw new LiveGateNotObservedError(
      'ARBITRARY_TEXT_UNSUPPORTED',
      'the diagnostic gate generates its own verification nonce and does not accept chat body text',
    );
  }
  const {
    adapter,
    env = process.env,
    readConversationAuthorizations,
    conversationId,
    idempotencyKey = `f247-in-place-${randomUUID()}`,
  } = options;
  const nonce = `F247_IN_PLACE_LIVE_GATE_${new Date().toISOString()}_${randomUUID()}`;
  const authorization = await requireInstalledAuthorization(readConversationAuthorizations, env, conversationId);
  const delivery = await verifyBoundDelivery({
    adapter: adapter ?? (await createInstalledAdapter(env)),
    conversationId: authorization.conversationId,
    text: nonce,
    idempotencyKey,
  });
  return {
    kind: 'diagnostic_receipt',
    status: 'PASS',
    coverage: 'running-owner-chrome-native-messaging-full-seam',
    browserLifecycle: 'untouched',
    foregroundMutation: 'none-by-construction',
    canonicalThreadProjection: false,
    hostMessageId: delivery.hostMessageId,
    retryHostMessageId: delivery.retryHostMessageId,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPersonalChromeInPlaceLiveGate()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      if (error instanceof LiveGateNotObservedError) {
        process.stdout.write(
          `${JSON.stringify(
            {
              status: error.reason === 'NEEDS_BINDING' ? 'NEEDS_BINDING' : 'NOT_OBSERVED',
              reason: error.reason,
              detail: error.message,
              browserLifecycle: 'untouched',
              foregroundMutation: 'none-by-construction',
            },
            null,
            2,
          )}\n`,
        );
        process.exitCode = 2;
        return;
      }
      process.stderr.write(
        `F247 in-place Personal Chrome live gate failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
