export type ReevalClosureStatus =
  | 'open'
  | 'acknowledged'
  | 'acted'
  | 'resolved_by_reeval'
  | 'accepted_suppressed'
  | 'escalated';

export interface ReevalClosureRecord {
  handoffId: string;
  status: ReevalClosureStatus;
  openedAt: string;
  ownerResponseRef?: string;
  reevalRef?: string;
  closureEvidence?: string;
}

export type ReevalClosureEvent =
  | { type: 'owner_response'; ref: string }
  | { type: 'owner_action'; ref: string }
  | { type: 'reeval_passed'; ref: string; evidence: string }
  | { type: 'cvo_accept_suppress'; ref: string; evidence: string }
  | { type: 'sla_elapsed'; now: string; acknowledgeHours: number };

export function transitionReevalClosure(record: ReevalClosureRecord, event: ReevalClosureEvent): ReevalClosureRecord {
  switch (event.type) {
    case 'owner_response':
      if (record.status !== 'open' && record.status !== 'acknowledged') return record;
      return { ...record, status: 'acknowledged', ownerResponseRef: event.ref };
    case 'owner_action':
      if (record.status !== 'open' && record.status !== 'acknowledged') return record;
      return { ...record, status: 'acted', ownerResponseRef: event.ref };
    case 'reeval_passed':
      if (record.status !== 'acted') return record;
      return { ...record, status: 'resolved_by_reeval', reevalRef: event.ref, closureEvidence: event.evidence };
    case 'cvo_accept_suppress':
      if (record.status !== 'acted') return record;
      return { ...record, status: 'accepted_suppressed', reevalRef: event.ref, closureEvidence: event.evidence };
    case 'sla_elapsed': {
      if (record.status !== 'open') return record;
      const openedAt = Date.parse(record.openedAt);
      const now = Date.parse(event.now);
      const elapsedHours = (now - openedAt) / 3_600_000;
      if (Number.isFinite(elapsedHours) && elapsedHours >= event.acknowledgeHours) {
        return {
          ...record,
          status: 'escalated',
          closureEvidence: `SLA elapsed after ${Math.floor(elapsedHours)}h without owner response`,
        };
      }
      return record;
    }
  }
}
