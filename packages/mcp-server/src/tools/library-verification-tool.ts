import { deploymentDefaults } from '@cat-cafe/shared';
import { z } from 'zod';
import { bindMcpImplementation, defineMcpTool } from '../tool-governance.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';
import { invocationFetch, resolveInvocationEnv } from './invocation-auth.js';

const actions = ['confirm', 'mark_stale', 'escalate', 'dismiss_review'] as const;
export const libraryVerifyInputSchema = {
  anchor: z.string().min(1).describe('Exact document anchor to act on, e.g. F188 or LL-029.'),
  action: z
    .enum(actions)
    .describe(
      'confirm: mark reviewed; mark_stale: request review; escalate: flag human attention; dismiss_review: clear review status.',
    ),
  actor: z.string().min(1).describe('Cat ID or human identifier recorded in the verification audit log.'),
};
const requestSchema = z.object(libraryVerifyInputSchema).strict();

export async function handleLibraryVerify(input: z.infer<typeof requestSchema>): Promise<ToolResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return errorResult(`Invalid library verification ${issue?.path.join('.') || 'input'}: ${issue?.message}`);
  }
  try {
    const apiUrl = resolveInvocationEnv('CAT_CAFE_API_URL') ?? deploymentDefaults.apiBaseUrl;
    const response = await invocationFetch(`${apiUrl}/api/f163/verification/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      previousStatus?: string;
      newStatus?: string;
    };
    if (!response.ok) return errorResult(`library_verify failed (${response.status}): ${data.error ?? 'unknown'}`);
    return successResult(
      `✅ Verification action applied: ${input.anchor} — ${input.action}\n` +
        `  Previous: ${data.previousStatus ?? 'null'} → New: ${data.newStatus ?? 'null'}`,
    );
  } catch (err) {
    return errorResult(`library_verify error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sourceRef = 'file:packages/mcp-server/src/tools/library-verification-tool.ts' as const;
const boundary = {
  risk: { level: 'write', openWorld: false },
  authorizationPaths: [
    {
      principal: 'local-operator',
      credentialSource: 'local-process',
      scope: { kind: 'local-runtime' },
      enforcementRef: 'file:packages/api/src/routes/f163-audit-routes.ts',
    },
  ],
} as const;
const variant = (action: (typeof actions)[number]) => ({
  action,
  inputSchema: { ...libraryVerifyInputSchema, action: z.literal(action) },
  boundary,
});

export const libraryVerificationTool = defineMcpTool({
  name: 'cat_cafe_library_verify',
  description:
    'Record a document review decision. Use when: reviewing a flagged document. ' +
    'NOT for: automatic fact checking or collection maintenance. ' +
    'Output: updates review status and audit log. GOTCHA: writes data; confirm requires needs_review.',
  operation: {
    kind: 'discriminated',
    discriminator: 'action',
    variants: [variant(actions[0]), variant(actions[1]), variant(actions[2]), variant(actions[3])],
  },
  implementation: bindMcpImplementation(
    'module:./tools/library-verification-tool.js#handleLibraryVerify',
    handleLibraryVerify,
  ),
  policy: {
    resourceFamily: 'library',
    runtimeProfiles: ['full'],
    activeState: 'canonical',
    schemaDelivery: { policy: 'host-default', candidate: 'discoverable', evidenceRef: sourceRef },
    owner: { domainCell: 'architecture-cell:memory', surface: 'mcp-surface-governance' },
    standaloneReason: {
      disposition: 'accepted-boundary',
      kind: 'side-effect-boundary',
      admissionRef: 'file:docs/features/F332-experience-informed-memory.md',
    },
    cognitiveEntryPoints: [{ kind: 'tool-description', ref: sourceRef }],
    verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/memory-entry-contracts.test.js' }],
  },
});
