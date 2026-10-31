import { z } from 'zod';
import {
  bindMcpImplementation,
  defineMcpTool,
  type McpImplementationBinding,
  type McpOperationContract,
} from '../tool-governance.js';

/** Both development entries expose their closed action inventory and exact callback authority. */
export function defineDevelopmentTool(input: {
  name: string;
  description: string;
  sourceFile: string;
  exportName: string;
  callbackFile: string;
  inputSchema: Record<string, unknown>;
  handler: McpImplementationBinding['run'];
  actions: readonly [string, ...string[]];
}) {
  const sourceRef = `file:packages/mcp-server/src/tools/${input.sourceFile}` as const;
  const variant = (action: string) => ({
    action,
    inputSchema: { ...input.inputSchema, action: z.literal(action) },
    boundary: {
      risk: {
        level: action === 'read' || action === 'resolve' ? ('read' as const) : ('write' as const),
        openWorld: false,
      },
      authorizationPaths: [
        {
          principal: 'invocation-cat' as const,
          credentialSource: 'invocation-record' as const,
          scope: { kind: 'owner' as const, resourceRef: 'task-workflow' },
          enforcementRef: `file:packages/api/src/routes/${input.callbackFile}` as const,
        },
      ] as const,
    },
  });
  const [first, ...rest] = input.actions;
  const operation: McpOperationContract =
    rest.length === 0
      ? {
          kind: 'single',
          action: first,
          inputSchema: input.inputSchema,
          boundary: variant(first).boundary,
        }
      : {
          kind: 'discriminated',
          discriminator: 'action',
          variants: [variant(first), ...rest.map(variant)],
        };
  return defineMcpTool({
    name: input.name,
    description: input.description,
    operation,
    implementation: bindMcpImplementation(
      `module:./tools/${input.sourceFile.replace(/\.ts$/, '.js')}#${input.exportName}`,
      input.handler,
    ),
    policy: {
      resourceFamily: 'task-workflow',
      runtimeProfiles: ['full'],
      activeState: 'canonical',
      schemaDelivery: { policy: 'host-default', evidenceRef: sourceRef },
      owner: { domainCell: 'architecture-cell:hub-action-surface', surface: 'mcp-surface-governance' },
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'authority-boundary',
        admissionRef: 'file:docs/features/F310-growing-real-delegation.md',
      },
      cognitiveEntryPoints: [
        { kind: 'tool-description', ref: sourceRef },
        { kind: 'skill', ref: 'file:cat-cafe-skills/custody-recognition/SKILL.md' },
      ],
      verification: [{ kind: 'test', ref: 'test:packages/mcp-server/test/f310-development-work-tools.test.ts' }],
    },
  });
}
