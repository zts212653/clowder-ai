import { z } from 'zod';
import { projectAgentKeyCollaborationContract } from './agent-key-collaboration-contract.js';
import { jsonSchemaToZod } from './json-schema-to-zod.js';
import type { FamilyToolDefinition } from './tool-governance-snapshot.js';
import { type PostMessageRegistrationPrincipal, projectPostMessageInputSchema } from './tools/callback-tools.js';

function buildRegistrationContract(tool: FamilyToolDefinition, principal: PostMessageRegistrationPrincipal) {
  const isPostMessage = tool.name === 'cat_cafe_post_message';
  const canonicalSchema = isPostMessage ? projectPostMessageInputSchema(principal) : tool.inputSchema;
  const agentContract =
    principal === 'agent-key'
      ? projectAgentKeyCollaborationContract(tool.name, canonicalSchema, tool.description)
      : undefined;
  const schema = agentContract?.inputSchema ?? canonicalSchema;
  let inputSchema =
    typeof schema.type === 'string' && typeof schema.properties === 'object' && schema.properties !== null
      ? jsonSchemaToZod(schema)
      : z.object(schema as z.ZodRawShape);
  if ((isPostMessage && principal === 'invocation') || agentContract || tool.name === 'cat_cafe_get_recall_metrics')
    inputSchema = (inputSchema as z.ZodObject<z.ZodRawShape>).strict();
  return { description: agentContract?.description ?? tool.description, inputSchema };
}

// Only immutable schema derivations are shared. Canonical definition identity
// versions the key; each definition has exactly three possible principal shapes.
// No invocation, family grant, actor, display response or handler is retained.
const contracts = new WeakMap<
  FamilyToolDefinition,
  Map<PostMessageRegistrationPrincipal, ReturnType<typeof buildRegistrationContract>>
>();

export function projectRegistrationContract(tool: FamilyToolDefinition, principal: PostMessageRegistrationPrincipal) {
  let shapes = contracts.get(tool);
  if (!shapes) {
    shapes = new Map();
    contracts.set(tool, shapes);
  }
  const cached = shapes.get(principal);
  if (cached) return cached;
  const contract = buildRegistrationContract(tool, principal);
  shapes.set(principal, contract);
  return contract;
}
