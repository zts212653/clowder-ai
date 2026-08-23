#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PERSONAL_CHROME_AUTHORIZATION_LIMIT,
  readPersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import {
  inspectNativeHostInstallation,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import { resolvePersonalChromeHostPaths } from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';
import { extensionIdFromManifestKey } from './f247-personal-chrome-live-contract.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const monorepoRoot = resolve(apiRoot, '../..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;

function errorCode(error) {
  return typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : undefined;
}

function typedOperationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function probeNativeHostSocket(socketPath, timeoutMs = 500) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (error, connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(connected);
    };
    socket.once('connect', () => finish(undefined, true));
    socket.once('error', (error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED') finish(undefined, false);
      else finish(error);
    });
    socket.setTimeout(timeoutMs, () => finish(new Error('personal Chrome helper health probe timed out')));
  });
}

async function resolveExtensionId(explicitExtensionId) {
  if (explicitExtensionId !== undefined) {
    if (typeof explicitExtensionId !== 'string' || !CHROME_EXTENSION_ID.test(explicitExtensionId)) {
      throw new Error('extensionId must be a 32-character Chrome extension ID');
    }
    return explicitExtensionId;
  }
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  return extensionIdFromManifestKey(manifest.key);
}

export function resolveChromeWebStoreDistribution(webStoreListingUrl, extensionId) {
  if (webStoreListingUrl === undefined || webStoreListingUrl === '') {
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'unavailable',
      blockerCode: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
    };
  }
  try {
    if (typeof webStoreListingUrl !== 'string' || webStoreListingUrl.trim() !== webStoreListingUrl) {
      throw new Error('listing URL must be exact');
    }
    const url = new URL(webStoreListingUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'chromewebstore.google.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      segments[0] !== 'detail' ||
      segments.length < 2 ||
      segments.at(-1) !== extensionId
    ) {
      throw new Error('listing URL is not the expected Chrome Web Store listing');
    }
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'published',
      listingUrl: url.href,
    };
  } catch {
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'invalid',
      blockerCode: 'CHROME_WEB_STORE_LISTING_INVALID',
    };
  }
}

function baseState({ platform, distribution }) {
  const unsupported = platform === 'win32';
  return {
    pluginId: 'personal-chrome-host',
    channel: 'developer_preview',
    platform,
    platformSupport: unsupported ? 'unsupported' : 'supported',
    artifact: {
      helper: unsupported ? 'unsupported' : 'absent',
      extension: 'chrome_web_store',
    },
    distribution,
    config: { status: unsupported ? 'unsupported' : 'absent' },
    authorization: {
      status: unsupported ? 'unsupported' : 'empty',
      count: 0,
      limit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
      conversations: [],
    },
    intent: { status: 'developer_preview' },
    live: { status: unsupported ? 'unsupported' : 'dormant' },
  };
}

function projectAuthorizations(collection) {
  const conversations = collection.conversations.map(({ conversationId, authorizedAt, updatedAt }) => ({
    conversationId,
    authorizedAt,
    updatedAt,
  }));
  return {
    status: conversations.length > 0 ? 'authorized' : 'empty',
    count: conversations.length,
    limit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
    conversations,
  };
}

export async function inspectPersonalChromePluginState({
  platform = process.platform,
  projectRoot,
  extensionId,
  webStoreListingUrl = process.env.CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL,
  inspectInstallation = inspectNativeHostInstallation,
  readAuthorizations = readPersonalChromeConversationAuthorizations,
  probeLive = probeNativeHostSocket,
} = {}) {
  const resolvedExtensionId = await resolveExtensionId(extensionId);
  const state = baseState({
    platform,
    distribution: resolveChromeWebStoreDistribution(webStoreListingUrl, resolvedExtensionId),
  });
  if (state.platformSupport === 'unsupported') return state;

  const resolvedProjectRoot = projectRoot ?? process.env.CAT_CAFE_CONFIG_ROOT?.trim() ?? monorepoRoot;
  const paths = resolvePersonalChromeHostPaths(resolvedProjectRoot, { platform });
  let installation;
  try {
    installation = await inspectInstallation({ platform, projectRoot: resolvedProjectRoot });
    state.artifact.helper = 'ready';
    state.config.status = 'ready';
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      state.artifact.helper = 'invalid';
      state.config.status = 'invalid';
      state.live.status = 'degraded';
    }
  }

  try {
    state.authorization = projectAuthorizations(await readAuthorizations(paths.conversationBindingPath));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'NEEDS_AUTHORIZATION') {
      state.authorization = {
        status: 'invalid',
        count: 0,
        limit: PERSONAL_CHROME_AUTHORIZATION_LIMIT,
        conversations: [],
      };
    }
  }

  if (!installation) return state;
  try {
    state.live.status = (await probeLive(installation.socketPath)) ? 'connected' : 'dormant';
  } catch {
    state.live.status = 'degraded';
  }
  return state;
}

export function createPersonalChromePluginPort({
  platform = process.platform,
  projectRoot,
  extensionId,
  webStoreListingUrl = process.env.CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL,
  installHost = installNativeHost,
  uninstallHost = uninstallNativeHost,
  inspectInstallation = inspectNativeHostInstallation,
  readAuthorizations = readPersonalChromeConversationAuthorizations,
  revokeAuthorization = revokePersonalChromeConversation,
  probeLive = probeNativeHostSocket,
  now = () => new Date(),
} = {}) {
  const resolvedProjectRoot = projectRoot ?? process.env.CAT_CAFE_CONFIG_ROOT?.trim() ?? monorepoRoot;
  const inspect = async () =>
    inspectPersonalChromePluginState({
      platform,
      projectRoot: resolvedProjectRoot,
      extensionId,
      webStoreListingUrl,
      inspectInstallation,
      readAuthorizations,
      probeLive,
    });
  const requireSupported = () => {
    if (platform === 'win32') {
      throw typedOperationError('UNSUPPORTED_PLATFORM', 'Windows Personal Chrome install is not implemented');
    }
  };
  const installOrRepair = async () => {
    requireSupported();
    const resolvedExtensionId = await resolveExtensionId(extensionId);
    const distribution = resolveChromeWebStoreDistribution(webStoreListingUrl, resolvedExtensionId);
    if (distribution.publication !== 'published') {
      throw typedOperationError(
        distribution.blockerCode,
        'a published Chrome Web Store listing is required before installation',
      );
    }
    await installHost({ platform, projectRoot: resolvedProjectRoot, extensionId: resolvedExtensionId });
    return inspect();
  };
  const revoke = async (conversationId) => {
    requireSupported();
    const paths = resolvePersonalChromeHostPaths(resolvedProjectRoot, { platform });
    const result = await revokeAuthorization(paths.conversationBindingPath, conversationId, now().toISOString());
    if (!result.revoked) {
      throw typedOperationError('AUTHORIZATION_NOT_FOUND', 'conversation authorization was not found');
    }
    return inspect();
  };
  const uninstall = async () => {
    requireSupported();
    try {
      await uninstallHost({ platform, projectRoot: resolvedProjectRoot });
    } catch (error) {
      if (error instanceof Error && error.message.includes('helper is active')) {
        throw typedOperationError('HELPER_ACTIVE', 'personal Chrome helper is active');
      }
      throw error;
    }
    return inspect();
  };
  return {
    inspect,
    install: installOrRepair,
    repair: installOrRepair,
    revoke,
    uninstall,
  };
}

export async function runPersonalChromeInstall({ action = 'install', projectRoot, env = process.env } = {}) {
  const port = createPersonalChromePluginPort({
    projectRoot: projectRoot ?? env.CAT_CAFE_CONFIG_ROOT?.trim() ?? monorepoRoot,
    webStoreListingUrl: env.CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL,
  });
  if (action === 'install') return port.install();
  if (action === 'inspect') return port.inspect();
  if (action === 'uninstall') return port.uninstall();
  throw new Error('action must be install, inspect, or uninstall');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runPersonalChromeInstall({ action: process.argv[2] ?? 'install' })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(
        `F247 personal Chrome install failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      process.exitCode = 1;
    });
}
