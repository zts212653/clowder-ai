'use client';

import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createApprovalActionSurface, createWorkspaceModeSurface } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';

/** F266 proposalIdFromRef and F246 approval refs name the same exact proposal identity. */
export function evolutionApprovalId(ref?: OwnerTruthRefV1): string | undefined {
  if (!ref) return undefined;
  const prefix =
    ref.ownerFeatureId === 'F246' ? 'approval:' : ref.ownerFeatureId === 'F266' ? 'eval-repair-proposal:' : undefined;
  if (!prefix || !ref.ownerStateRef.startsWith(prefix)) return undefined;
  return ref.ownerStateRef.slice(prefix.length).trim() || undefined;
}

export function openEvolutionApproval(proposalId: string): void {
  const chat = useChatStore.getState();
  const surface = createApprovalActionSurface(createWorkspaceModeSurface('approval', chat.currentThreadId), proposalId);
  if (!surface) return;
  chat.setWorkspaceMode('dev');
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'open-surface',
    surface,
    entitlement: { kind: 'user', reason: 'open-from-chat' },
  });
}
