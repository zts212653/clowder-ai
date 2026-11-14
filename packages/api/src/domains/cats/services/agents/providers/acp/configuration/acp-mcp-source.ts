import { resolveBinaryRoot } from '../../../../../../../config/capabilities/capability-orchestrator.js';
import {
  assertMappedCapabilitySource,
  resolveInvokeCapabilityRoot,
} from '../../../../../../../config/capabilities/invoke-capability-root.js';
import { readInvocationMcpConfig } from '../../../../../../../config/capabilities/invoke-mcp-config.js';
import { resolveAcpMcpServers, resolveDisabledServerIds, resolveUserProjectMcpServers } from '../acp-mcp-resolver.js';
import { captureSessionMcpServers } from '../acp-session-env.js';
import type { AcpMcpServer } from '../types.js';

/** Share source admission between normal turns and the definition-only check. */
export async function captureAcpMcpSources(input: {
  projectRoot: string;
  catId: string;
  mcpSupport: boolean;
  mcpWhitelist: readonly string[] | null;
  userProjectRoot?: string;
  legacyServers?: AcpMcpServer[];
}) {
  const { projectRoot, catId, mcpSupport, mcpWhitelist, userProjectRoot } = input;
  let servers: AcpMcpServer[];
  if (!mcpSupport) servers = [];
  else if (mcpWhitelist !== null) {
    const binaryRoot = resolveBinaryRoot(projectRoot);
    const capabilitiesRoot = await resolveInvokeCapabilityRoot(binaryRoot);
    const { config, configSourceRoot, accessScope } = readInvocationMcpConfig(capabilitiesRoot, userProjectRoot);
    assertMappedCapabilitySource(config !== null, binaryRoot, capabilitiesRoot);
    const disabled = resolveDisabledServerIds(projectRoot, catId, config, { accessScope });
    servers = await resolveAcpMcpServers(projectRoot, [...mcpWhitelist], undefined, {
      mcpSupport,
      disabledServerIds: disabled,
      catId,
      capabilitiesConfig: config,
      configSourceRoot,
      accessScope,
    });
  } else servers = input.legacyServers ?? [];
  if (mcpSupport && userProjectRoot && userProjectRoot !== projectRoot) {
    const names = new Set(servers.map((server) => server.name));
    servers = [...servers, ...resolveUserProjectMcpServers(userProjectRoot, names)];
  }
  return captureSessionMcpServers(servers);
}
