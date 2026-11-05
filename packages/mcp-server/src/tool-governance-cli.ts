import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CANONICAL_TOOL_REGISTRY } from './canonical-server-tools.js';
import { type AtomicCutoverManifest, validateAtomicCutovers } from './tool-cutover.js';
import { scanRetiredNames } from './tool-cutover-consumer-scan.js';
import {
  createBootstrapAttestation,
  digestGovernanceValue,
  MCP_SURFACE_ATTESTATION_PATH,
  MCP_SURFACE_BASELINE_PATH,
  parseBootstrapAttestation,
  resolveGovernanceTarget,
  useAttestedExportedBaselineProjection,
  validateBootstrapAttestation,
} from './tool-governance-bootstrap.js';
import { resolveBootstrapTargetProof } from './tool-governance-bootstrap-git.js';
import { resolveToolGovernanceEvidence } from './tool-governance-evidence.js';
import { resolveMcpImplementationCatalog } from './tool-governance-implementation.js';
import { createProtectedSnapshotFromWorktree } from './tool-governance-protected-worktree.js';
import {
  compareMcpSurfaceProtocol,
  compareMcpSurfaceRegistry,
  createMcpSurfaceSnapshot,
  type McpSurfaceSnapshot,
  serializeMcpSurfaceSnapshot,
} from './tool-governance-snapshot.js';
import type { EvidenceRef, McpToolDefinition, ProtectedToolSnapshot } from './tool-governance-types.js';
import { validateToolGovernance } from './tool-governance-validation.js';

const run = promisify(execFile);

async function git(repoRoot: string, args: readonly string[], allowFailure = false): Promise<string | null> {
  try {
    const result = await run('git', [...args], { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} failed: ${detail.stderr ?? detail.message ?? ''}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function targetHasBaseline(repoRoot: string, sha: string): Promise<boolean> {
  return (await git(repoRoot, ['cat-file', '-e', `${sha}:${MCP_SURFACE_BASELINE_PATH}`], true)) !== null;
}

async function targetBaseline(repoRoot: string, sha: string): Promise<McpSurfaceSnapshot | undefined> {
  const content = await git(repoRoot, ['show', `${sha}:${MCP_SURFACE_BASELINE_PATH}`], true);
  return content ? (JSON.parse(content) as McpSurfaceSnapshot) : undefined;
}

function evidenceRefs(definitions: readonly McpToolDefinition[]): readonly EvidenceRef[] {
  const refs = new Set<EvidenceRef>();
  for (const definition of definitions) {
    const boundaries =
      definition.operation.kind === 'single'
        ? [definition.operation.boundary]
        : definition.operation.variants.map((variant) => variant.boundary);
    boundaries
      .flatMap((boundary) => boundary.authorizationPaths)
      .forEach((path) => {
        refs.add(path.enforcementRef);
      });
    if (definition.operation.kind === 'single') {
      definition.operation.closedSelectors?.forEach((selector) => {
        refs.add(selector.evidenceRef);
      });
    }
    refs.add(definition.policy.schemaDelivery.evidenceRef);
    refs.add(definition.policy.owner.domainCell);
    const reason = definition.policy.standaloneReason;
    refs.add(reason.disposition === 'accepted-boundary' ? reason.admissionRef : reason.evidenceRef);
    definition.policy.cognitiveEntryPoints.forEach((entry) => {
      refs.add(entry.ref);
    });
    definition.policy.verification.forEach((entry) => {
      refs.add(entry.ref);
    });
  }
  return [...refs].sort();
}

function protectedMap(snapshot: McpSurfaceSnapshot): ReadonlyMap<string, ProtectedToolSnapshot> {
  return new Map(
    snapshot.tools.map((tool) => [
      tool.name,
      {
        name: tool.name,
        resourceFamily: tool.resourceFamily,
        actions: tool.actions,
        risk: {
          level: tool.annotations.destructiveHint ? 'destructive' : tool.annotations.readOnlyHint ? 'read' : 'write',
          openWorld: tool.annotations.openWorldHint,
        },
        inputSchemaDigest: tool.inputSchemaDigest,
      },
    ]),
  );
}

async function currentSnapshot(
  repoRoot: string,
  protectedBaseSha: string,
): Promise<{
  snapshot: McpSurfaceSnapshot;
  implementations: Awaited<ReturnType<typeof resolveMcpImplementationCatalog>>;
}> {
  const implementations = await resolveMcpImplementationCatalog({
    repoRoot,
    definitions: CANONICAL_TOOL_REGISTRY,
  });
  return {
    implementations,
    snapshot: createMcpSurfaceSnapshot(CANONICAL_TOOL_REGISTRY, {
      protectedBaseSha,
      implementationCatalog: implementations,
    }),
  };
}

async function validateDefinitions(
  repoRoot: string,
  snapshot: McpSurfaceSnapshot,
  implementations: Awaited<ReturnType<typeof resolveMcpImplementationCatalog>>,
): Promise<void> {
  const evidence = await resolveToolGovernanceEvidence({ repoRoot, refs: evidenceRefs(CANONICAL_TOOL_REGISTRY) });
  const result = validateToolGovernance(CANONICAL_TOOL_REGISTRY, {
    evidenceCatalog: evidence,
    implementationCatalog: implementations,
    protectedBase: protectedMap(snapshot),
  });
  if (!result.ok) throw new Error(`MCP governance validation failed:\n${JSON.stringify(result.findings, null, 2)}`);
}

async function readManifests(repoRoot: string): Promise<readonly AtomicCutoverManifest[]> {
  const directory = resolve(repoRoot, 'packages/mcp-server/governance/cutovers');
  if (!(await exists(directory))) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map((name) => readJson<AtomicCutoverManifest>(resolve(directory, name))));
}

function report(before: McpSurfaceSnapshot, after: McpSurfaceSnapshot): string {
  const delta = compareMcpSurfaceRegistry(before, after);
  const descriptionDelta =
    after.tools.reduce((sum, tool) => sum + tool.descriptionCharacters, 0) -
    before.tools.reduce((sum, tool) => sum + tool.descriptionCharacters, 0);
  const tokenDelta =
    after.tools.reduce((sum, tool) => sum + tool.descriptionTokensCl100kBase, 0) -
    before.tools.reduce((sum, tool) => sum + tool.descriptionTokensCl100kBase, 0);
  return [
    `MCP surface governance: tools=${after.tools.length} added=${delta.addedNames.length} removed=${delta.removedNames.length} descriptionCharsDelta=${descriptionDelta} cl100kDelta=${tokenDelta}`,
    `MCP surface delta: ${JSON.stringify(delta)}`,
  ].join('\n');
}

async function validateCutovers(
  before: McpSurfaceSnapshot,
  after: McpSurfaceSnapshot,
  repoRoot: string,
): Promise<void> {
  const manifests = await readManifests(repoRoot);
  const scans = await scanRetiredNames(
    repoRoot,
    manifests.flatMap((manifest) => manifest.retiredNames),
  );
  const surface = (snapshot: McpSurfaceSnapshot) =>
    snapshot.tools.map((tool) => ({
      name: tool.name,
      resourceFamily: tool.resourceFamily,
      runtimeProfiles: tool.runtimeProfiles,
    }));
  const result = validateAtomicCutovers({ before: surface(before), after: surface(after), manifests, scans });
  if (!result.ok) throw new Error(`MCP cutover validation failed:\n${JSON.stringify(result.findings, null, 2)}`);
}

type GovernanceCommand = 'attest-bootstrap' | 'write' | 'check';

function requestedCommand(args: readonly string[]): GovernanceCommand {
  if (args.length !== 1) throw new Error('Use exactly one command: attest-bootstrap, write, or check');
  const command = args[0];
  if (command !== 'attest-bootstrap' && command !== 'write' && command !== 'check') {
    throw new Error(`Unknown governance command: ${command}`);
  }
  return command;
}

async function writeBootstrapAttestation(input: {
  resolvedTargetSha: string;
  hasTargetBaseline: boolean;
  baselinePath: string;
  attestationPath: string;
}): Promise<void> {
  if (await exists(input.attestationPath)) throw new Error('Bootstrap attestation already exists');
  const attestation = createBootstrapAttestation(input.resolvedTargetSha);
  validateBootstrapAttestation(attestation, {
    mode: 'attest',
    resolvedTargetSha: input.resolvedTargetSha,
    targetHasBaseline: input.hasTargetBaseline,
    currentHasBaseline: await exists(input.baselinePath),
  });
  await mkdir(dirname(input.attestationPath), { recursive: true });
  await writeFile(input.attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = requestedCommand(process.argv.slice(2));
  const repoRoot = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])) as string;
  const target = resolveGovernanceTarget(process.env.CAT_CAFE_GATE_BASE_SHA);
  if (target.fetchLatest) await git(repoRoot, ['fetch', 'origin', 'main']);
  const resolvedTargetSha = (await git(repoRoot, ['rev-parse', target.ref])) as string;
  const baselinePath = resolve(repoRoot, MCP_SURFACE_BASELINE_PATH);
  const attestationPath = resolve(repoRoot, MCP_SURFACE_ATTESTATION_PATH);
  const hasTargetBaseline = await targetHasBaseline(repoRoot, resolvedTargetSha);

  if (command === 'attest-bootstrap') {
    await writeBootstrapAttestation({ resolvedTargetSha, hasTargetBaseline, baselinePath, attestationPath });
    return;
  }
  const attestation = await readJson<unknown>(attestationPath);
  const parsedAttestation = parseBootstrapAttestation(attestation);
  const previous = await targetBaseline(repoRoot, resolvedTargetSha);
  const currentBaselineExists = await exists(baselinePath);
  const currentBaseline = currentBaselineExists ? await readJson<McpSurfaceSnapshot>(baselinePath) : undefined;
  const targetProof = hasTargetBaseline
    ? await resolveBootstrapTargetProof({
        readGit: (args, allowFailure) => git(repoRoot, args, allowFailure),
        resolvedTargetSha,
        attestation: parsedAttestation,
      })
    : undefined;
  const parsed = validateBootstrapAttestation(parsedAttestation, {
    mode: command,
    resolvedTargetSha,
    targetHasBaseline: hasTargetBaseline,
    currentHasBaseline: !hasTargetBaseline && command === 'write' ? true : currentBaselineExists,
    targetBaselineProtectedBaseSha: previous?.protectedBaseSha,
    targetProof,
  });
  const current = await currentSnapshot(repoRoot, parsed.bootstrapFrom);
  const projectionCandidate = command === 'write' ? current.snapshot : currentBaseline;
  const useProjectedBaseline =
    previous !== undefined &&
    projectionCandidate !== undefined &&
    targetProof?.kind === 'exported' &&
    useAttestedExportedBaselineProjection(
      targetProof.target,
      digestGovernanceValue(previous),
      digestGovernanceValue(projectionCandidate),
    );
  const protectedSnapshot =
    (useProjectedBaseline ? projectionCandidate : previous) ??
    (await createProtectedSnapshotFromWorktree({
      repoRoot,
      protectedBaseSha: parsed.bootstrapFrom,
      currentSnapshot: current.snapshot,
      currentDefinitions: CANONICAL_TOOL_REGISTRY,
    }));
  if (!previous) {
    const parity = compareMcpSurfaceProtocol(protectedSnapshot, current.snapshot);
    if (parity.length > 0) throw new Error(`Protected-base protocol drift:\n${JSON.stringify(parity, null, 2)}`);
  }
  await validateDefinitions(repoRoot, protectedSnapshot, current.implementations);
  await validateCutovers(protectedSnapshot, current.snapshot, repoRoot);
  const serialized = serializeMcpSurfaceSnapshot(current.snapshot);
  if (command === 'write') {
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, serialized);
  } else if ((await readFile(baselinePath, 'utf8')).replace(/\r\n/g, '\n') !== serialized) {
    throw new Error('Committed MCP surface baseline differs from the canonical registry; run governance:write');
  }
  process.stdout.write(`${report(protectedSnapshot, current.snapshot)}\n`);
}

await main();
