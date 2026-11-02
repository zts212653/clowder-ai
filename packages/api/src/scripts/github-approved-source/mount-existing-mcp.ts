import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fileBasedMcpIO, installMcpCapability } from '../../config/capabilities/capability-mcp-service.js';
import { readCapabilitiesConfig } from '../../config/capabilities/capability-orchestrator.js';
import { reconcileCatRegistry } from '../../config/cat-registry-reconciliation.js';
import { FilePluginInventoryStore } from '../../domains/plugin/host-inventory/stores.js';
import { APPROVAL } from './approved-scope.js';
import { assertMcpMountTarget, GITHUB_MCP_ID, verifyGitHubMcpMount } from './mcp-mount-authority.js';

const SOURCE = '/home/user/cat-cafe-runtime';
const TARGET = '/home/user/cat-cafe';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** One owner-authorized repair through the existing managed MCP install pipeline.
 * Never calls a plugin action, reads a callback credential, or writes inventory/grants. */
export async function mountExistingGitHubMcp(approvalSource: string, apply: boolean) {
  if (approvalSource !== APPROVAL.archiveApprovalSourceRef)
    throw new Error('Exact direct installation source required');
  const inventoryPath = join(SOURCE, '.cat-cafe/plugin-host/inventory.json');
  const inventory = new FilePluginInventoryStore(inventoryPath);
  const snapshot = await inventory.snapshot();
  const source = await readCapabilitiesConfig(SOURCE);
  const { entry, workingDir } = verifyGitHubMcpMount(
    snapshot,
    source?.capabilities.find((e) => e.id === GITHUB_MCP_ID),
  );
  if ((await realpath(entry.mcpServer?.command ?? '')) !== (await realpath(process.execPath)))
    throw new Error('Declared transport is not the current Host Node executable');
  const root = await realpath(workingDir);
  const resources = await realpath(join(SOURCE, '.cat-cafe/plugin-host/resources'));
  const rel = relative(resources, root);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Declared package escaped Host resources');
  const markerPath = join(root, '.clowder-mcp-resource.json');
  const info = await stat(markerPath);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o022) !== 0)
    throw new Error('Invalid Host MCP materialization');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  if (
    marker.pluginId !== 'official.github-operations' ||
    marker.packageDigest !== APPROVAL.archiveDigest ||
    marker.materializationVersion !== 3
  )
    throw new Error('Approved materialized package identity differs');
  const target = await readCapabilitiesConfig(TARGET);
  if (!target) throw new Error('Canonical capability source must already exist');
  const previous = assertMcpMountTarget(target.capabilities, entry);
  const mountEntry = { ...entry, ...(previous?.blockedCats ? { blockedCats: [...previous.blockedCats] } : {}) };
  const ownedBefore = digest(target.capabilities.filter((e) => e.id === GITHUB_MCP_ID));
  const unrelatedBefore = digest(target.capabilities.filter((e) => e.id !== GITHUB_MCP_ID));
  if (apply) {
    // Reuse the normal locked managed-install, CLI reconciliation and redacted audit.
    // The caller never extracts or substitutes the Host connection token.
    reconcileCatRegistry(TARGET, new Set());
    const base = fileBasedMcpIO(TARGET);
    const sourceDigest = digest(source),
      inventoryDigest = digest(snapshot);
    await installMcpCapability(
      TARGET,
      mountEntry,
      {
        ...base,
        readConfig: async () => {
          if (
            digest(await readCapabilitiesConfig(SOURCE)) !== sourceDigest ||
            digest(await inventory.snapshot()) !== inventoryDigest
          )
            throw new Error('Installation changed before mount; retry from live authority');
          const current = await base.readConfig();
          if (!current) throw new Error('Canonical capability source disappeared');
          assertMcpMountTarget(current.capabilities, entry);
          if (digest(current.capabilities.filter((e) => e.id === GITHUB_MCP_ID)) !== ownedBefore)
            throw new Error('Owner capability policy changed before mount; retry');
          if (digest(current.capabilities.filter((e) => e.id !== GITHUB_MCP_ID)) !== unrelatedBefore)
            throw new Error('Unrelated owner configuration changed; retry');
          return current;
        },
      },
      { userId: 'default-user' },
    );
    const after = await readCapabilitiesConfig(TARGET);
    if (
      !after ||
      digest(after.capabilities.filter((e) => e.id !== GITHUB_MCP_ID)) !== unrelatedBefore ||
      digest(after.capabilities.find((e) => e.id === GITHUB_MCP_ID)?.mcpServer) !== digest(entry.mcpServer) ||
      digest(after.capabilities.find((e) => e.id === GITHUB_MCP_ID)?.blockedCats ?? []) !==
        digest(mountEntry.blockedCats ?? [])
    )
      throw new Error('Managed mount verification failed');
  }
  return {
    applied: apply,
    capabilityId: GITHUB_MCP_ID,
    sourceRoot: SOURCE,
    targetRoot: TARGET,
    packageSha256: APPROVAL.archiveSha256,
    descriptorDigest: digest(entry),
    inventoryOrGrantMutation: false,
    callbackCredentialRead: false,
    opaqueConnectionPreserved: true,
    unrelatedCapabilitiesPreserved: true,
  };
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { 'approval-source': { type: 'string' }, apply: { type: 'boolean' } },
      allowPositionals: false,
    });
    console.log(JSON.stringify(await mountExistingGitHubMcp(values['approval-source'] ?? '', values.apply === true)));
  } catch {
    console.error('Declared MCP mount refused; no transport credentials printed.');
    process.exitCode = 1;
  }
}
