import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock('../../HubRoutingPolicyTab', () => ({
  HubRoutingPolicyTab: () => <div data-testid="routing-policy">routing-policy</div>,
}));
vi.mock('../../HubToolUsageTab', () => ({
  HubToolUsageTab: () => <div data-testid="tool-usage">tool-usage</div>,
}));
vi.mock('../../HubLeaderboardTab', () => ({
  HubLeaderboardTab: () => <div data-testid="leaderboard">leaderboard</div>,
}));
vi.mock('../../HubObservabilityTab', () => ({
  HubObservabilityTab: (props: { initialSubTab?: string }) => (
    <div data-testid="observability" data-subtab={props.initialSubTab ?? 'default'}>
      observability
    </div>
  ),
}));
vi.mock('../../HubAgentSessionsTab', () => ({
  HubAgentSessionsTab: () => <div data-testid="agent-sessions">agent-sessions</div>,
}));
vi.mock('../../HubGovernanceTab', () => ({
  HubGovernanceTab: () => <div data-testid="governance">governance</div>,
}));
vi.mock('../../BrakeSettingsPanel', () => ({
  BrakeSettingsPanel: () => <div data-testid="brake">brake</div>,
}));
vi.mock('../../HubCommandsTab', () => ({
  HubCommandsTab: () => <div data-testid="commands">commands</div>,
}));
vi.mock('../../HubClaudeRescueSection', () => ({
  HubClaudeRescueSection: () => <div data-testid="rescue">rescue</div>,
}));

import { OpsContent } from '../OpsContent';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('OpsContent URL deep-linking (S-2 P1 fix)', () => {
  it('defaults to usage tab when no URL params', () => {
    mockSearchParams = new URLSearchParams();
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="routing-policy"');
    expect(html).not.toContain('data-testid="agent-sessions"');
  });

  it('opens agent-sessions tab when ops=agent-sessions (P1-1: DaemonActiveIndicator deep-link)', () => {
    mockSearchParams = new URLSearchParams('ops=agent-sessions');
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="agent-sessions"');
    expect(html).not.toContain('data-testid="routing-policy"');
  });

  it('opens observability tab with callback-auth subtab when ops=observability&obs=callback-auth (P1-2)', () => {
    mockSearchParams = new URLSearchParams('ops=observability&obs=callback-auth');
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="observability"');
    expect(html).toContain('data-subtab="callback-auth"');
  });

  it('opens observability tab with default subtab when obs param absent', () => {
    mockSearchParams = new URLSearchParams('ops=observability');
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="observability"');
    expect(html).toContain('data-subtab="default"');
  });

  it('falls back to usage when ops param is an unknown value', () => {
    mockSearchParams = new URLSearchParams('ops=nonexistent');
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="routing-policy"');
  });

  it('ignores invalid obs param and defaults observability to overview (cloud P2)', () => {
    mockSearchParams = new URLSearchParams('ops=observability&obs=bogus');
    const html = renderToStaticMarkup(<OpsContent />);
    expect(html).toContain('data-testid="observability"');
    expect(html).toContain('data-subtab="default"');
  });
});
