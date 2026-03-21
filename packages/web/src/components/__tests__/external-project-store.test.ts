import type { ExternalProject, IntentCard, NeedAuditFrame } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useExternalProjectStore } from '../../stores/externalProjectStore';

const mockProject: ExternalProject = {
  id: 'ep-001',
  userId: 'user1',
  name: 'studio-flow',
  description: 'Client project',
  sourcePath: '/tmp/sf',
  backlogPath: 'docs/ROADMAP.md',
  createdAt: 1000,
  updatedAt: 1000,
};

const mockCard: IntentCard = {
  id: 'ic-001',
  projectId: 'ep-001',
  actor: 'Admin',
  contextTrigger: 'Order arrives',
  goal: 'Approve order',
  objectState: 'Approved',
  successSignal: 'SLA met',
  nonGoal: 'Auto-approve',
  sourceTag: 'Q',
  sourceDetail: 'Interview',
  decisionOwner: 'CEO',
  confidence: 3,
  dependencyTags: [],
  riskSignals: [],
  triage: null,
  originalText: 'Admin approves orders',
  createdAt: 1000,
  updatedAt: 1000,
};

const mockFrame: NeedAuditFrame = {
  id: 'frame-001',
  projectId: 'ep-001',
  sponsor: 'CEO',
  motivation: 'Digitize',
  successMetric: 'Review < 2h',
  constraints: '3 months',
  currentWorkflow: 'Excel',
  provenanceMap: 'CEO interview',
  createdAt: 1000,
  updatedAt: 1000,
};

describe('useExternalProjectStore', () => {
  beforeEach(() => {
    useExternalProjectStore.setState({
      projects: [],
      activeProjectId: null,
      intentCards: [],
      auditFrame: null,
      loading: false,
      error: null,
    });
  });

  it('sets and retrieves projects', () => {
    useExternalProjectStore.getState().setProjects([mockProject]);
    expect(useExternalProjectStore.getState().projects).toHaveLength(1);
    expect(useExternalProjectStore.getState().projects[0].name).toBe('studio-flow');
  });

  it('sets active project id', () => {
    useExternalProjectStore.getState().setActiveProjectId('ep-001');
    expect(useExternalProjectStore.getState().activeProjectId).toBe('ep-001');
  });

  it('sets intent cards', () => {
    useExternalProjectStore.getState().setIntentCards([mockCard]);
    expect(useExternalProjectStore.getState().intentCards).toHaveLength(1);
    expect(useExternalProjectStore.getState().intentCards[0].actor).toBe('Admin');
  });

  it('sets audit frame', () => {
    useExternalProjectStore.getState().setAuditFrame(mockFrame);
    expect(useExternalProjectStore.getState().auditFrame?.sponsor).toBe('CEO');
  });

  it('clears audit frame with null', () => {
    useExternalProjectStore.getState().setAuditFrame(mockFrame);
    useExternalProjectStore.getState().setAuditFrame(null);
    expect(useExternalProjectStore.getState().auditFrame).toBeNull();
  });

  it('sets loading state', () => {
    useExternalProjectStore.getState().setLoading(true);
    expect(useExternalProjectStore.getState().loading).toBe(true);
  });

  it('sets error state', () => {
    useExternalProjectStore.getState().setError('Network error');
    expect(useExternalProjectStore.getState().error).toBe('Network error');
  });
});
