import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import type { TeamWorkspaceSubject } from '@/stores/chat-types';

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !value.includes('\0');
}

export function encodeTeamWorkspaceSubject(subject: TeamWorkspaceSubject): string {
  return encodeURIComponent(JSON.stringify(subject));
}

export function decodeTeamWorkspaceSubject(value: string): TeamWorkspaceSubject | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as { type?: unknown; id?: unknown };
    if ((parsed.type !== 'cat' && parsed.type !== 'provider') || !isSafeId(parsed.id)) return null;
    return { type: parsed.type, id: parsed.id };
  } catch {
    return null;
  }
}

export function resolveTeamWorkspaceSubject(
  subject: TeamWorkspaceSubject | null,
  readModel: RoutingContextReadModelV1,
): TeamWorkspaceSubject | null {
  if (!subject || readModel.resolution.state === 'degraded') return subject;
  const candidates = readModel.resolution.snapshot.candidates;
  const exists = candidates.some((candidate) =>
    subject.type === 'cat' ? candidate.binding.catId === subject.id : candidate.binding.providerId === subject.id,
  );
  return exists ? subject : null;
}
