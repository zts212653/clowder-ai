/**
 * F099: RightPanelToggle three-state cycle regression test
 * Tests the REAL exported rightPanelToggleTransition function from ChatContainerHeader.
 * Cycle: closed → status → workspace → closed
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rightPanelToggleTransition } from '../ChatContainerHeader';

describe('F099 RightPanelToggle three-state cycle', () => {
  let panelOpen: boolean;
  let mode: 'status' | 'workspace' | 'transcript';
  const togglePanel = () => {
    panelOpen = !panelOpen;
  };
  const setMode = (m: 'status' | 'workspace' | 'transcript') => {
    mode = m;
  };

  beforeEach(() => {
    panelOpen = false;
    mode = 'status';
  });

  it('closed → status: opens panel in status mode', () => {
    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });

    expect(panelOpen).toBe(true);
    expect(mode).toBe('status');
  });

  it('status → workspace: switches to workspace without toggling panel', () => {
    panelOpen = true;
    mode = 'status';
    const spy = vi.fn(togglePanel);

    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: spy,
      setRightPanelMode: setMode,
    });

    expect(spy).not.toHaveBeenCalled();
    expect(panelOpen).toBe(true);
    expect(mode).toBe('workspace');
  });

  it('workspace → closed: closes panel and resets to status mode', () => {
    panelOpen = true;
    mode = 'workspace';

    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });

    expect(panelOpen).toBe(false);
    expect(mode).toBe('status');
  });

  it('transcript → closed: closes panel and resets to status mode', () => {
    panelOpen = true;
    mode = 'transcript';

    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });

    expect(panelOpen).toBe(false);
    expect(mode).toBe('status');
  });

  it('full cycle: closed → status → workspace → closed', () => {
    // Step 1: closed → status
    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });
    expect(panelOpen).toBe(true);
    expect(mode).toBe('status');

    // Step 2: status → workspace
    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });
    expect(panelOpen).toBe(true);
    expect(mode).toBe('workspace');

    // Step 3: workspace → closed
    rightPanelToggleTransition(panelOpen, mode, {
      onToggleStatusPanel: togglePanel,
      setRightPanelMode: setMode,
    });
    expect(panelOpen).toBe(false);
    expect(mode).toBe('status');
  });
});
