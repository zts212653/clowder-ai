import { type CompanionReply, validateCompanionReply } from '@clowder-ai/plugin-contract-beta25';
import { CompanionBridgeError } from '../companion-owner-client.js';

/** The original work owner binds project, source and display authority; this consumer accepts no selectors. */
export interface CompanionWorkPort {
  read(): Promise<unknown>;
  open(entryRef: string): Promise<'applied' | 'queued' | 'blocked' | 'unconfirmed'>;
  reset(): void;
}

export function assertCompanionWorkProject(boundProjectPath: string, currentProjectPath: string): void {
  if (boundProjectPath !== currentProjectPath) throw new CompanionBridgeError('cancelled');
}

export async function readCompanionWorkPort(port: CompanionWorkPort | undefined): Promise<CompanionReply> {
  if (port) {
    const reply = await port.read();
    if (validateCompanionReply(reply) && reply.kind === 'work') return reply;
  }
  return { kind: 'error', code: 'unavailable' };
}

export function companionWorkNavigationFailure(error: unknown): Extract<CompanionReply, { kind: 'navigation' }> {
  const blocked = error instanceof CompanionBridgeError && ['cancelled', 'permission_required'].includes(error.code);
  return { kind: 'navigation', delivery: blocked ? 'blocked' : 'unconfirmed' };
}
