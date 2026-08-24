#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removePersonalChromeConversationAuthorizations } from './conversation-binding.mjs';
import { digestNativeHostArtifactDirectory, publishNativeHostArtifact } from './native-host-artifact.mjs';
import {
  pathExists,
  readManifest,
  readOptionalFileSnapshot,
  restoreFileSnapshot,
  writeAtomicFile,
} from './native-host-install-files.mjs';
import { acquireProcessLease } from './native-socket-lease.mjs';
import {
  readPersonalChromePairingRecord,
  redactPersonalChromePairingRecord,
  resolvePersonalChromeHostPaths,
  writePersonalChromePairingRecordAtomic,
} from './pairing-record.mjs';

export const PERSONAL_CHROME_NATIVE_HOST_NAME = 'ai.catcafe.personal_cloud_cat_host';
const CHROME_EXTENSION_ID = /^[a-p]{32}$/;
const sourceDirectoryDefault = dirname(fileURLToPath(import.meta.url));

function assertInstallMutationSupported(platform) {
  if (platform === 'win32') {
    throw new Error('Windows Native Messaging install requires registry activation and is not implemented');
  }
}

function requireExact(value, label) {
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

function renderNativeHostLauncher({ nodeExecutable, artifactEntrypoint, pairingRecordPath }) {
  requireAbsolute(nodeExecutable, 'nodeExecutable');
  requireAbsolute(artifactEntrypoint, 'artifactEntrypoint');
  requireAbsolute(pairingRecordPath, 'pairingRecordPath');
  return `#!/bin/sh\nexec ${quoteShellArgument(nodeExecutable)} ${quoteShellArgument(
    artifactEntrypoint,
  )} --pairing-record ${quoteShellArgument(pairingRecordPath)} "$@"\n`;
}

async function assertNodeRuntimeExecutable(nodeExecutable) {
  requireAbsolute(nodeExecutable, 'nodeExecutable');
  const metadata = await stat(nodeExecutable);
  if (!metadata.isFile()) throw new Error('nodeExecutable must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new Error('nodeExecutable must be executable');
  }
}

function manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory }) {
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

function installationReceipt({ operation, paths, manifestPath, record, artifactEntrypoint }) {
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

export async function inspectNativeHostInstallation({
  platform = process.platform,
  projectRoot,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  nodeExecutable = process.execPath,
} = {}) {
  assertInstallMutationSupported(platform);
  await assertNodeRuntimeExecutable(nodeExecutable);
  const paths = resolvePersonalChromeHostPaths(projectRoot);
  const record = await readPersonalChromePairingRecord(paths.pairingRecordPath);
  const artifactDirectory = join(paths.artifactsDirectory, record.artifactDigest.slice('sha512:'.length));
  const artifactEntrypoint = join(artifactDirectory, 'native-host-cli.mjs');
  if ((await digestNativeHostArtifactDirectory(artifactDirectory)) !== record.artifactDigest) {
    throw new Error('installed native host artifact digest mismatch');
  }
  const plan = buildNativeHostInstallPlan({
    platform,
    homeDirectory,
    localAppData,
    userDataDirectory,
    extensionId: record.extensionId,
    nativeHostPath: paths.launcherPath,
  });
  const manifest = await readManifest(plan.manifestPath);
  if (JSON.stringify(manifest) !== JSON.stringify(plan.manifest))
    throw new Error('native host manifest does not match pairing');
  const launcherMetadata = await stat(paths.launcherPath);
  if (!launcherMetadata.isFile()) throw new Error('native host launcher must be a regular file');
  if (platform !== 'win32' && (launcherMetadata.mode & 0o111) === 0) {
    throw new Error('native host launcher must be executable');
  }
  const expectedLauncher = renderNativeHostLauncher({
    nodeExecutable,
    artifactEntrypoint,
    pairingRecordPath: paths.pairingRecordPath,
  });
  if ((await readFile(paths.launcherPath, 'utf8')) !== expectedLauncher) {
    throw new Error('native host launcher does not match installed runtime');
  }
  return installationReceipt({
    operation: 'inspect',
    paths,
    manifestPath: plan.manifestPath,
    record,
    artifactEntrypoint,
  });
}

async function assertManifestOwnedOrAbsent(manifestPath, launcherPath) {
  if (!(await pathExists(manifestPath))) return;
  const manifest = await readManifest(manifestPath);
  if (manifest?.name !== PERSONAL_CHROME_NATIVE_HOST_NAME || manifest?.path !== launcherPath) {
    throw new Error('refusing to overwrite a Native Messaging manifest not owned by this installation');
  }
}

async function inspectOptionalInstallation(options) {
  try {
    return await inspectNativeHostInstallation(options);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    // A prior process may have stopped between activation-file writes. The
    // canonical pairing record remains the last committed generation, so the
    // next explicit install is allowed to repair launcher/manifest around it.
    return undefined;
  }
}

async function readOptionalPairingRecord(pairingRecordPath) {
  try {
    return await readPersonalChromePairingRecord(pairingRecordPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function installNativeHostLocked({
  platform = process.platform,
  projectRoot,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  extensionId,
  sourceDirectory = sourceDirectoryDefault,
  now = () => new Date(),
  generatePairingSecret = () => randomBytes(32).toString('base64url'),
  writePairingRecord = writePersonalChromePairingRecordAtomic,
  nodeExecutable = process.execPath,
  paths,
}) {
  requireExact(extensionId, 'extensionId');
  if (!CHROME_EXTENSION_ID.test(extensionId)) throw new Error('extensionId must be a 32-character Chrome extension ID');
  await assertNodeRuntimeExecutable(nodeExecutable);
  const existingManifestLocation = manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory });
  await assertManifestOwnedOrAbsent(existingManifestLocation.manifestPath, paths.launcherPath);
  const previousRecord = await readOptionalPairingRecord(paths.pairingRecordPath);
  if (previousRecord && previousRecord.extensionId !== extensionId) {
    throw new Error('installed extension identity is immutable; uninstall before changing extension ID');
  }
  const artifact = await publishNativeHostArtifact(sourceDirectory, paths.artifactsDirectory);
  const existing = await inspectOptionalInstallation({
    platform,
    projectRoot,
    homeDirectory,
    localAppData,
    userDataDirectory,
    nodeExecutable,
  });
  if (existing && existing.extensionId === extensionId && existing.artifactDigest === artifact.artifactDigest) {
    return { ...existing, operation: 'unchanged' };
  }

  const timestamp = now().toISOString();
  const record = {
    schemaVersion: 1,
    extensionId,
    socketPath: paths.socketPath,
    ledgerPath: paths.ledgerPath,
    pairingSecret: previousRecord?.pairingSecret ?? generatePairingSecret(),
    artifactDigest: artifact.artifactDigest,
    installedAt: previousRecord?.installedAt ?? timestamp,
    updatedAt: timestamp,
  };
  const launcherSource = renderNativeHostLauncher({
    nodeExecutable,
    artifactEntrypoint: artifact.artifactEntrypoint,
    pairingRecordPath: paths.pairingRecordPath,
  });
  const plan = buildNativeHostInstallPlan({
    platform,
    homeDirectory,
    localAppData,
    userDataDirectory,
    extensionId,
    nativeHostPath: paths.launcherPath,
  });
  const launcherSnapshot = await readOptionalFileSnapshot(paths.launcherPath);
  const manifestSnapshot = await readOptionalFileSnapshot(plan.manifestPath);
  try {
    await writeAtomicFile(paths.launcherPath, launcherSource, 0o700);
    await writeAtomicFile(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, 0o600);
    await writePairingRecord(paths.pairingRecordPath, record);
  } catch (error) {
    const rollbackErrors = [];
    await restoreFileSnapshot(paths.launcherPath, launcherSnapshot).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    await restoreFileSnapshot(plan.manifestPath, manifestSnapshot).catch((rollbackError) =>
      rollbackErrors.push(rollbackError),
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'native host install failed and activation rollback was incomplete',
      );
    }
    throw error;
  }
  return installationReceipt({
    operation: previousRecord ? 'repaired' : 'installed',
    paths,
    manifestPath: plan.manifestPath,
    record,
    artifactEntrypoint: artifact.artifactEntrypoint,
  });
}

async function runInstallationMutation(paths, platform, operation) {
  await mkdir(paths.rootDirectory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') await chmod(paths.rootDirectory, 0o700);
  const lease = await acquireProcessLease(join(paths.rootDirectory, 'install'), {
    label: 'native host installation',
  });
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

export async function installNativeHost(options = {}) {
  const { platform = process.platform } = options;
  assertInstallMutationSupported(platform);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  return runInstallationMutation(paths, platform, () => installNativeHostLocked({ ...options, platform, paths }));
}
async function uninstallNativeHostLocked({
  platform = process.platform,
  homeDirectory = homedir(),
  localAppData = process.env.LOCALAPPDATA,
  userDataDirectory,
  paths,
}) {
  if ((await pathExists(paths.socketPath)) || (await pathExists(`${paths.socketPath}.owner`))) {
    throw new Error('personal Chrome helper is active; stop Chrome before uninstall');
  }
  const location = manifestLocation({ platform, homeDirectory, localAppData, userDataDirectory });
  if (await pathExists(location.manifestPath)) {
    const manifest = await readManifest(location.manifestPath);
    if (manifest?.name !== PERSONAL_CHROME_NATIVE_HOST_NAME || manifest?.path !== paths.launcherPath) {
      throw new Error('refusing to remove a Native Messaging manifest not owned by this installation');
    }
    await unlink(location.manifestPath);
  }
  await unlink(paths.pairingRecordPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await unlink(paths.launcherPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await removePersonalChromeConversationAuthorizations(paths.conversationBindingPath);
  return {
    status: 'absent',
    operation: 'uninstalled',
    rootDirectory: paths.rootDirectory,
    manifestPath: location.manifestPath,
    pairingRecordPath: paths.pairingRecordPath,
    launcherPath: paths.launcherPath,
    ledgerRetained: await pathExists(paths.ledgerPath),
    conversationBindingRemoved: !(await pathExists(paths.conversationBindingPath)),
  };
}
export async function uninstallNativeHost(options = {}) {
  const { platform = process.platform } = options;
  assertInstallMutationSupported(platform);
  const paths = resolvePersonalChromeHostPaths(options.projectRoot);
  return runInstallationMutation(paths, platform, () => uninstallNativeHostLocked({ ...options, platform, paths }));
}
function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const plan = buildNativeHostInstallPlan({
      platform: process.platform,
      homeDirectory: homedir(),
      localAppData: process.env.LOCALAPPDATA,
      extensionId: argumentValue('--extension-id'),
      nativeHostPath: argumentValue('--host-path'),
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`native host install plan failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  }
}
