import { describe, expect, it } from 'vitest';
import { APPROVAL_FEATURE_IDS, APPROVAL_FEATURES } from '../approval-features';

describe('Approval Hub feature registry', () => {
  it('owns every currently admitted feature in one place', () => {
    expect(APPROVAL_FEATURE_IDS).toEqual(['F128', 'F139', 'F225', 'F193', 'F231', 'F260', 'F221', 'F276']);
  });

  it('provides F139 labels and its feature-owned decision endpoint', () => {
    expect(APPROVAL_FEATURES.F139).toMatchObject({
      label: '定时',
      badgeLabel: 'Schedule',
      decisionEndpointBase: '/api/schedule-proposals',
      sourcePolicy: 'message-or-event',
    });
  });

  it('provides distinct human and badge labels for Taste', () => {
    expect(APPROVAL_FEATURES.F221).toMatchObject({
      label: '品味',
      badgeLabel: 'Taste',
      decisionEndpointBase: '/api/taste-proposals',
      sourcePolicy: 'message-or-event',
    });
  });
});
