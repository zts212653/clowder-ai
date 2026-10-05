import { asCodexAppServerRecord, type CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';

export const REQUIRED_TOOLS_UNAVAILABLE = 'required_tools_unavailable' as const;
const REQUIRED_TOOL_ID_SEPARATOR = '::';
const MCP_INVENTORY_DEADLINE_MS = 2_500;
const MCP_STARTUP_RETRY_DELAY_MS = 100;
const MCP_STARTUP_RETRY_LIMIT = 25;

export interface RequiredToolsUnavailableDetails {
  readonly code: typeof REQUIRED_TOOLS_UNAVAILABLE;
  readonly missingTools: readonly string[];
}

/**
 * A non-transient pre-turn boundary: the native thread did not expose every
 * explicitly declared tool. Callers must preserve the request for recovery;
 * they must not start a model turn and hope that prompt prose compensates.
 */
export class CodexRequiredToolsUnavailableError extends Error {
  readonly details: RequiredToolsUnavailableDetails;

  constructor(missingTools: readonly string[]) {
    const normalized = normalizeRequiredTools(missingTools);
    super(`Required tools unavailable: ${normalized.join(', ')}`);
    this.name = 'CodexRequiredToolsUnavailableError';
    this.details = Object.freeze({
      code: REQUIRED_TOOLS_UNAVAILABLE,
      missingTools: Object.freeze([...normalized]),
    });
  }
}

export function normalizeRequiredTools(input: readonly string[] | undefined): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of input ?? []) {
    const tool = value.trim();
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    normalized.push(tool);
  }
  return Object.freeze(normalized);
}

interface McpStatusPage {
  readonly servers: readonly unknown[];
  readonly nextCursor: string | null;
}

interface McpToolInventory {
  readonly available: ReadonlySet<string>;
  readonly statuses: ReadonlyMap<string, string>;
}

interface ServerToolInventoryEntry {
  readonly serverName: string;
  readonly runtimeStatus: string;
  readonly toolIds: readonly string[];
}

function readStatusPage(value: unknown): McpStatusPage | null {
  const record = asCodexAppServerRecord(value);
  if (!Array.isArray(record?.data)) return null;
  if (record.nextCursor !== undefined && record.nextCursor !== null && typeof record.nextCursor !== 'string')
    return null;
  return {
    servers: record.data,
    nextCursor: typeof record.nextCursor === 'string' && record.nextCursor ? record.nextCursor : null,
  };
}

function serverToolInventoryEntry(value: unknown): ServerToolInventoryEntry | null {
  const server = asCodexAppServerRecord(value);
  if (!server) return null;
  const serverName = typeof server.name === 'string' ? server.name.trim() : '';
  if (!serverName) return null;
  const runtimeStatus = typeof server.runtimeStatus === 'string' ? server.runtimeStatus : '';
  if (runtimeStatus !== 'connected' || server.toolsError != null) return { serverName, runtimeStatus, toolIds: [] };
  const tools = asCodexAppServerRecord(server.tools);
  return {
    serverName,
    runtimeStatus,
    toolIds: tools ? Object.keys(tools).map((toolName) => `${serverName}${REQUIRED_TOOL_ID_SEPARATOR}${toolName}`) : [],
  };
}

function appendConnectedToolIds(target: Set<string>, statuses: Map<string, string>, servers: readonly unknown[]): void {
  for (const value of servers) {
    const entry = serverToolInventoryEntry(value);
    if (!entry) continue;
    statuses.set(entry.serverName, entry.runtimeStatus);
    for (const toolId of entry.toolIds) target.add(toolId);
  }
}

function isServerQualifiedToolId(value: string): boolean {
  const separator = value.indexOf(REQUIRED_TOOL_ID_SEPARATOR);
  return (
    separator > 0 &&
    separator === value.lastIndexOf(REQUIRED_TOOL_ID_SEPARATOR) &&
    separator + REQUIRED_TOOL_ID_SEPARATOR.length < value.length
  );
}

function serverNameOf(toolId: string): string {
  return toolId.slice(0, toolId.indexOf(REQUIRED_TOOL_ID_SEPARATOR));
}

function hasStartingRequiredServer(
  requiredServerNames: ReadonlySet<string>,
  statuses: ReadonlyMap<string, string>,
): boolean {
  return [...requiredServerNames].some((serverName) => {
    const status = statuses.get(serverName);
    return status === 'notStarted' || status === 'starting';
  });
}

function deadlineExceededError(): Error {
  return new Error('mcp_server_status_deadline');
}

function requestUntilDeadline(
  request: (method: string, params: CodexAppServerJsonObject) => Promise<unknown>,
  method: string,
  params: CodexAppServerJsonObject,
  deadlineAt: number,
): Promise<unknown> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.reject(deadlineExceededError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(deadlineExceededError());
    }, remainingMs);
    void Promise.resolve()
      .then(() => request(method, params))
      .then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

async function waitForMcpStatusRefresh(deadlineAt: number): Promise<boolean> {
  const delayMs = Math.min(MCP_STARTUP_RETRY_DELAY_MS, deadlineAt - Date.now());
  if (delayMs <= 0) return false;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return Date.now() < deadlineAt;
}

async function readMcpToolInventory(
  input: {
    readonly threadId: string;
    readonly request: (method: string, params: CodexAppServerJsonObject) => Promise<unknown>;
  },
  deadlineAt: number,
): Promise<McpToolInventory> {
  const available = new Set<string>();
  const statuses = new Map<string, string>();
  let cursor: string | null = null;
  let pagesRemaining = 10;
  do {
    if (pagesRemaining-- === 0) throw new Error('mcp_server_status_pagination_limit');
    const result = await requestUntilDeadline(
      input.request,
      'mcpServerStatus/list',
      {
        threadId: input.threadId,
        detail: 'full',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      },
      deadlineAt,
    );
    const page = readStatusPage(result);
    if (!page) throw new Error('mcp_server_status_malformed');
    appendConnectedToolIds(available, statuses, page.servers);
    cursor = page.nextCursor;
  } while (cursor);
  return { available, statuses };
}

/**
 * Read the tool surface that the provider says is active on this exact native
 * thread. Every requirement is a `serverName::toolName` identity: server
 * declarations and aggregate counts are deliberately ignored, and a matching
 * tool name from another server cannot satisfy the requirement.
 */
export async function assertCodexRequiredToolsAvailable(input: {
  readonly threadId: string;
  readonly requiredTools: readonly string[];
  readonly request: (method: string, params: CodexAppServerJsonObject) => Promise<unknown>;
}): Promise<void> {
  const requiredTools = normalizeRequiredTools(input.requiredTools);
  if (requiredTools.length === 0) return;
  const malformedRequirements = requiredTools.filter((tool) => !isServerQualifiedToolId(tool));
  if (malformedRequirements.length > 0) throw new CodexRequiredToolsUnavailableError(malformedRequirements);
  const requiredServerNames = new Set(requiredTools.map(serverNameOf));
  const deadlineAt = Date.now() + MCP_INVENTORY_DEADLINE_MS;

  for (let attempt = 0; attempt <= MCP_STARTUP_RETRY_LIMIT; attempt++) {
    let inventory: McpToolInventory;
    try {
      inventory = await readMcpToolInventory(input, deadlineAt);
    } catch {
      // The only safe conclusion when effective inventory cannot be read is that
      // no declared tool has been proven available on this thread.
      throw new CodexRequiredToolsUnavailableError(requiredTools);
    }
    if (Date.now() >= deadlineAt) throw new CodexRequiredToolsUnavailableError(requiredTools);

    const missingTools = requiredTools.filter((tool) => !inventory.available.has(tool));
    if (missingTools.length === 0) return;
    if (attempt === MCP_STARTUP_RETRY_LIMIT || !hasStartingRequiredServer(requiredServerNames, inventory.statuses))
      throw new CodexRequiredToolsUnavailableError(missingTools);
    if (!(await waitForMcpStatusRefresh(deadlineAt))) throw new CodexRequiredToolsUnavailableError(missingTools);
  }
}
