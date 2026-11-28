import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const bindingSchema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  catalogId: z.string().trim().min(1),
  packageName: z.string().trim().min(1),
  validatedPackageDigest: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  evidence: z.string().trim().min(1),
});

const cutoverSchema = z.object({
  version: z.literal(1),
  clients: z.record(
    z.string(),
    z.discriminatedUnion('state', [
      z.object({ state: z.literal('legacy') }),
      bindingSchema.extend({ state: z.literal('validated') }),
      bindingSchema.extend({ state: z.literal('active') }),
    ]),
  ),
});

/** This file belongs to the Host instance, independent of request-supplied project paths. */
export async function readActiveAgentAdapter(dataDir: string, client: string) {
  try {
    const text = await readFile(join(dataDir, 'agent-adapter-cutover.json'), 'utf8');
    const selection = cutoverSchema.parse(JSON.parse(text)).clients[client];
    if (selection?.state !== 'active') return undefined;
    const { pluginId, contributionId, catalogId, packageName } = selection;
    return { ref: { pluginId, contributionId }, catalog: { catalogId, packageName } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('agent_adapter_cutover_unavailable');
  }
}
