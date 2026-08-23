import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../../../../..');

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('F299 legacy retirement and F252 compatibility', () => {
  it('keeps persistent Session Chain status while retiring the duplicate AuditExplorer host', () => {
    const rightStatus = source('packages/web/src/components/RightStatusPanel.tsx');
    const trajectory = source('packages/web/src/components/workspace/trajectory/TrajectoryPanel.tsx');
    const detail = source('packages/web/src/components/workspace/trajectory/InvocationTrajectoryDetail.tsx');
    expect(rightStatus).toContain('SessionChainPanel');
    expect(rightStatus).not.toContain('AuditExplorerPanel');
    expect(trajectory).toContain('SessionChainPanel');
    expect(trajectory).toContain('SessionSearchTab');
    expect(detail).toContain('Raw');
  });

  it('keeps ThreadSidebar Theater and the legacy story URL while removing feature selector ownership', () => {
    const sidebar = source('packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx');
    const appShell = source('packages/web/src/components/AppShell.tsx');
    const theaterHost = source('packages/web/src/components/story-player/TheaterReplayHost.tsx');
    const storyRoute = source('packages/web/src/app/story/[storyId]/page.tsx');
    const trajectory = source('packages/web/src/components/workspace/trajectory/TrajectoryPanel.tsx');
    expect(sidebar).toContain('openTheaterReplay');
    expect(appShell).toContain('TheaterReplayHost');
    expect(theaterHost).toContain('TheaterOverlay');
    expect(storyRoute).toContain('storyId');
    expect(trajectory).not.toContain('/api/feat-trajectory/feats');
    expect(trajectory).not.toContain('Feature Story');
    expect(existsSync(resolve(repoRoot, 'packages/web/src/components/workspace/trajectory/TrajectoryCard.tsx'))).toBe(
      false,
    );
    expect(
      existsSync(resolve(repoRoot, 'packages/web/src/components/workspace/trajectory/__fixtures__/trajectory-mock.ts')),
    ).toBe(false);
  });

  it('keeps invocation trajectory reachable from the message action surface', () => {
    const actions = source('packages/web/src/components/MessageActions.tsx');
    expect(actions).toContain('message-action-invocation-trajectory');
    expect(actions).toContain('openMessageInvocationTrajectory');
  });
});
