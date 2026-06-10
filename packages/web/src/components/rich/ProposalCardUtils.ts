import type { RichCardBlock } from '@/stores/chat-types';
import type { ReportingModeEditValue } from './ProposalCardFields';

export type ProposalCardStatus = 'pending' | 'approving' | 'approved' | 'rejected';

export interface ProposalSnapshot {
  proposalId: string;
  status: ProposalCardStatus;
  createdThreadId?: string;
  reportingMode?: ReportingModeEditValue;
}

export interface ProposalFieldEdits {
  title: string;
  parentThreadId: string;
  preferredCats: string;
  initialMessage: string;
  projectPath: string;
  reportingMode: ReportingModeEditValue;
}

export function extractProposalId(block: RichCardBlock): string | null {
  const approveAction = block.actions?.find((a) => a.action === 'propose:approve');
  const id = approveAction?.payload?.proposalId;
  return typeof id === 'string' ? id : null;
}

export function readField(block: RichCardBlock, label: string): string {
  return block.fields?.find((f) => f.label === label)?.value ?? '';
}

export function parsePreferredCats(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '（未指定）');
}

export function readProjectPathEdit(block: RichCardBlock): string {
  const value = readField(block, '项目归属');
  return value.startsWith('/') ? value : '';
}

export function readReportingModeEdit(block: RichCardBlock): ReportingModeEditValue {
  const value = readField(block, '回报模式');
  if (value.includes('none') || value.includes('autonomous')) return 'none';
  if (value.includes('state-transitions')) return 'state-transitions';
  if (value.includes('blocking-ack')) return 'blocking-ack';
  return 'final-only';
}

export function isDefaultProjectOwnership(value: string): boolean {
  return value.length > 0 && !value.startsWith('/');
}
