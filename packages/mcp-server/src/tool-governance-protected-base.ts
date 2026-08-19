import { getEncoding } from 'js-tiktoken';
import {
  type McpSurfaceSnapshot,
  normalizeMcpAnnotations,
  normalizeMcpInputSchema,
} from './tool-governance-snapshot.js';
import type { McpImplementationBinding, McpRuntimeProfile, McpToolDefinition } from './tool-governance-types.js';

type LegacyTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: McpImplementationBinding['run'];
};

type LegacyEnv = { readonly?: boolean; hasAgentKey?: boolean; desktopMode?: string };
type LegacyBuilder = (env?: LegacyEnv) => readonly LegacyTool[];

export type LegacyServerToolsets = {
  buildCollabTools: LegacyBuilder;
  buildMemoryTools: LegacyBuilder;
  buildSignalTools: LegacyBuilder;
  buildLimbTools: LegacyBuilder;
  buildAudioTools: LegacyBuilder;
  buildFinanceTools: LegacyBuilder;
  AGENT_KEY_TOOLS: ReadonlySet<string>;
  EXPLICIT_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }>
  >;
};

export type ProtectedBaseSnapshotOptions = {
  protectedBaseSha: string;
  verifyImplementationBinding: (
    toolName: string,
    handler: McpImplementationBinding['run'],
    ref: McpImplementationBinding['ref'],
  ) => Promise<void>;
  implementationDigest: (ref: McpImplementationBinding['ref']) => Promise<string>;
};

const FAMILIES = [
  ['collab', 'buildCollabTools'],
  ['memory', 'buildMemoryTools'],
  ['signals', 'buildSignalTools'],
  ['limb', 'buildLimbTools'],
  ['audio', 'buildAudioTools'],
  ['finance', 'buildFinanceTools'],
] as const;

function toolsFor(legacy: LegacyServerToolsets, env?: LegacyEnv): readonly LegacyTool[] {
  return FAMILIES.flatMap(([, builder]) => legacy[builder](env));
}

function profileSets(legacy: LegacyServerToolsets): ReadonlyMap<McpRuntimeProfile, ReadonlySet<string>> {
  const names = (env?: LegacyEnv) => new Set(toolsFor(legacy, env).map((tool) => tool.name));
  return new Map([
    ['full', names()],
    ['readonly', names({ readonly: true })],
    ['agent-key', legacy.AGENT_KEY_TOOLS],
    ['desktop:fable-phase0', names({ desktopMode: 'fable-phase0' })],
    ['desktop:cloud-pro-phase0', names({ desktopMode: 'cloud-pro-phase0' })],
  ]);
}

export async function createProtectedBaseSnapshot(
  current: McpSurfaceSnapshot,
  definitions: readonly McpToolDefinition[],
  legacy: LegacyServerToolsets,
  options: ProtectedBaseSnapshotOptions,
): Promise<McpSurfaceSnapshot> {
  const currentByName = new Map(current.tools.map((tool) => [tool.name, tool]));
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const profiles = profileSets(legacy);
  const legacyTools = FAMILIES.flatMap(([serverFamily, builder]) =>
    legacy[builder]().map((tool) => ({ ...tool, serverFamily })),
  );
  const names = new Set<string>();
  const encoding = getEncoding('cl100k_base');
  const tools = [];
  for (const legacyTool of legacyTools.sort((left, right) => left.name.localeCompare(right.name))) {
    if (names.has(legacyTool.name)) throw new Error(`Duplicate protected-base tool: ${legacyTool.name}`);
    names.add(legacyTool.name);
    const expected = currentByName.get(legacyTool.name);
    const definition = definitionsByName.get(legacyTool.name);
    if (!expected || !definition) throw new Error(`Protected-base tool is not governed: ${legacyTool.name}`);
    const ref = definition.implementation.ref;
    await options.verifyImplementationBinding(legacyTool.name, legacyTool.handler, ref);
    const annotations = legacy.EXPLICIT_TOOL_ANNOTATIONS[legacyTool.name];
    if (!annotations) throw new Error(`Protected-base annotation is missing: ${legacyTool.name}`);
    tools.push({
      ...expected,
      serverFamily: legacyTool.serverFamily,
      description: legacyTool.description,
      descriptionCharacters: legacyTool.description.length,
      descriptionTokensCl100kBase: encoding.encode(legacyTool.description).length,
      inputSchema: normalizeMcpInputSchema(legacyTool.inputSchema),
      annotations: normalizeMcpAnnotations(annotations),
      runtimeProfiles: [...profiles.entries()]
        .filter(([, members]) => members.has(legacyTool.name))
        .map(([profile]) => profile)
        .sort(),
      protectedImplementationDigest: await options.implementationDigest(ref),
    });
  }
  for (const name of currentByName.keys()) {
    if (!names.has(name)) throw new Error(`Current governed tool is absent from protected base: ${name}`);
  }
  return {
    schemaVersion: 1,
    protectedBaseSha: options.protectedBaseSha,
    comparisonEncoding: 'cl100k_base',
    tools,
  };
}
