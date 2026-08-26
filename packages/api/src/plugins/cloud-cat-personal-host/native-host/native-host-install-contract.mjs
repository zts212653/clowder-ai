import { stat } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';

import { redactPersonalChromePairingRecord } from './pairing-record.mjs';

export const PERSONAL_CHROME_NATIVE_HOST_NAME = 'ai.catcafe.personal_cloud_cat_host';
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;

export class PersonalChromeNativeHostInstallationError extends Error {
  constructor(code, message, installation) {
    super(message);
    this.name = 'PersonalChromeNativeHostInstallationError';
    this.code = code;
    if (installation) this.installation = installation;
  }
}

export function assertInstallMutationSupported(platform) {
  if (platform === 'win32') {
    throw new Error('Windows Native Messaging install requires registry activation and is not implemented');
  }
}

export function requireExact(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function requireAbsolute(value, label) {
  requireExact(value, label);
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderNativeHostLauncher({ nodeExecutable, artifactEntrypoint, pairingRecordPath }) {
  requireAbsolute(nodeExecutable, 'nodeExecutable');
  requireAbsolute(artifactEntrypoint, 'artifactEntrypoint');
  requireAbsolute(pairingRecordPath, 'pairingRecordPath');
  return `#!/bin/sh\nexec ${quoteShellArgument(nodeExecutable)} ${quoteShellArgument(
    artifactEntrypoint,
  )} --pairing-record ${quoteShellArgument(pairingRecordPath)} "$@"\n`;
}

export async function assertNodeRuntimeExecutable(nodeExecutable) {
  requireAbsolute(nodeExecutable, 'nodeExecutable');
  const metadata = await stat(nodeExecutable);
  if (!metadata.isFile()) throw new Error('nodeExecutable must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new Error('nodeExecutable must be executable');
  }
}

export function manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory }) {
  if (userDataDirectory && platform !== 'win32') {
    requireExact(userDataDirectory, 'userDataDirectory');
    if (!isAbsolute(userDataDirectory)) throw new Error('userDataDirectory must be absolute');
    return {
      manifestPath: join(userDataDirectory, 'NativeMessagingHosts', `${PERSONAL_CHROME_NATIVE_HOST_NAME}.json`),
    };
  }
  if (platform === 'darwin') {
    return {
      manifestPath: join(
        homeDirectory,
        'Library/Application Support/Google/Chrome/NativeMessagingHosts',
        `${PERSONAL_CHROME_NATIVE_HOST_NAME}.json`,
      ),
    };
  }
  if (platform === 'linux') {
    return {
      manifestPath: join(
        homeDirectory,
        '.config/google-chrome/NativeMessagingHosts',
        `${PERSONAL_CHROME_NATIVE_HOST_NAME}.json`,
      ),
    };
  }
  if (platform === 'win32') {
    const dataRoot = requireExact(localAppData, 'localAppData');
    return {
      manifestPath: win32.join(dataRoot, 'CatCafe', 'NativeMessagingHosts', `${PERSONAL_CHROME_NATIVE_HOST_NAME}.json`),
      registryKey: `HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${PERSONAL_CHROME_NATIVE_HOST_NAME}`,
    };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export function installationReceipt({ operation, paths, manifestPath, record, artifactEntrypoint }) {
  return {
    status: 'ready',
    operation,
    rootDirectory: paths.rootDirectory,
    pairingRecordPath: paths.pairingRecordPath,
    conversationBindingPath: paths.conversationBindingPath,
    launcherPath: paths.launcherPath,
    manifestPath,
    artifactEntrypoint,
    ...redactPersonalChromePairingRecord(record),
  };
}

export function buildNativeHostInstallPlan({
  platform,
  homeDirectory,
  localAppData,
  userDataDirectory,
  extensionId,
  nativeHostPath,
}) {
  requireExact(homeDirectory, 'homeDirectory');
  requireExact(extensionId, 'extensionId');
  requireExact(nativeHostPath, 'nativeHostPath');
  if (!CHROME_EXTENSION_ID.test(extensionId)) {
    throw new Error('extensionId must be a 32-character Chrome extension ID');
  }
  const absolutePath = platform === 'win32' ? win32.isAbsolute(nativeHostPath) : isAbsolute(nativeHostPath);
  if (!absolutePath) throw new Error('nativeHostPath must be absolute');
  return {
    ...manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory }),
    manifest: {
      name: PERSONAL_CHROME_NATIVE_HOST_NAME,
      description: 'Clowder AI personal cloud cat Native Messaging host',
      path: nativeHostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
  };
}
