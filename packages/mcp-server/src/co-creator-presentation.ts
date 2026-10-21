import { coCreatorContractMention, coCreatorDisplay } from '@cat-cafe/shared';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const configResponse = z.object({
  config: z.object({
    coCreator: z.object({
      name: z.string().min(1),
      nickname: z.string().optional(),
      mentionPatterns: z.array(z.string()),
    }),
  }),
});

type Presentation = ReturnType<typeof coCreatorDisplay>;
type Registration = { name: string; tool: RegisteredTool };
type ServerPresentation = { registrations: Registration[]; current: Presentation };
const presentations = new WeakMap<McpServer, ServerPresentation>();
const defaultPresentation = coCreatorDisplay({ name: 'co-creator', mentionPatterns: ['@co-creator'] });

/** These are display slots, never tool arguments, selectors, credentials or policy. */
export function renderCoCreatorText(text: string, current: Presentation): string {
  return text.replace(/\{\{coCreator\.(name|nickname|role|mention|mentionId)\}\}/g, (_slot, key: string) => {
    if (key === 'mentionId') return JSON.stringify(current.mention.replace(/^@/, '')).slice(1, -1);
    return current[key as keyof Presentation];
  });
}

function projectDescriptions(value: unknown, current: Presentation): unknown {
  if (Array.isArray(value)) return value.map((child) => projectDescriptions(child, current));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'description' && typeof child === 'string'
        ? renderCoCreatorText(child, current)
        : projectDescriptions(child, current),
    ]),
  );
}

async function readCurrentPresentation(current: Presentation): Promise<Presentation> {
  const apiUrl = process.env.CAT_CAFE_API_URL;
  if (!apiUrl) return current;
  try {
    // Read the existing API projection. Catalog/template resolution stays in the API.
    const response = await fetch(`${apiUrl}/api/config`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = configResponse.parse(await response.json());
    const display = coCreatorDisplay(parsed.config.coCreator);
    return { ...display, mention: coCreatorContractMention(display.mention) ?? '@co-creator' };
  } catch {
    // Retain the caller's last display during an API outage; callers without a
    // previous successful read use the role-based default.
    console.warn('[cat-cafe] Co-creator presentation unavailable; retaining the current tool display.');
  }
  return current;
}

/** Execution output must resolve its own display, even before a host lists tools. */
export async function renderCurrentCoCreatorText(text: string): Promise<string> {
  return renderCoCreatorText(text, await readCurrentPresentation(defaultPresentation));
}

function listRegistration({ name, tool }: Registration, current: Presentation): Tool {
  const schema = normalizeObjectSchema(tool.inputSchema);
  const listed: Tool = {
    name,
    title: tool.title,
    description: tool.description && renderCoCreatorText(tool.description, current),
    inputSchema: projectDescriptions(
      schema
        ? toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' })
        : { type: 'object', properties: {} },
      current,
    ) as Tool['inputSchema'],
    annotations: tool.annotations,
    execution: tool.execution,
    _meta: tool._meta,
  };
  if (tool.outputSchema) {
    const output = normalizeObjectSchema(tool.outputSchema);
    if (output) {
      listed.outputSchema = projectDescriptions(
        toJsonSchemaCompat(output, { strictUnions: true, pipeStrategy: 'input' }),
        current,
      ) as Tool['outputSchema'];
    }
  }
  return listed;
}

/**
 * Keep SDK registration/validation and all extra server tools intact. Only the
 * tools/list presentation is resolved again, including in a persistent session.
 */
export function registerCoCreatorPresentation(server: McpServer, name: string, tool: RegisteredTool): void {
  let state = presentations.get(server);
  if (!state) {
    state = {
      registrations: [],
      current: defaultPresentation,
    };
    presentations.set(server, state);
  }
  state.registrations.push({ name, tool });
  const presentation = state;
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const current = await readCurrentPresentation(presentation.current);
    presentation.current = current;
    return {
      tools: presentation.registrations
        .filter(({ tool: registered }) => registered.enabled)
        .map((registration) => listRegistration(registration, current)),
    };
  });
}
