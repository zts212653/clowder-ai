import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkSidebarProjectionBoundary } from './check-sidebar-projection-boundary.mjs';

function fixtureImport(...segments) {
  return segments.join('/');
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f297-sidebar-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'packages/api/src/routes',
    'packages/web/src/stores',
    'packages/web/src/components/ThreadSidebar',
    'packages/web/src/utils',
  ]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  writeFileSync(
    join(root, 'packages/api/src/routes/sidebar-presence-projection.ts'),
    `export const composeSidebarPresence = (source) => source.getPresence();`,
  );
  writeFileSync(
    join(root, 'packages/web/src/stores/sidebarProjectionStore.ts'),
    `
      export interface SidebarSnapshotRow {
        id: string;
        title: string | null;
        presence: { status: 'idle' | 'working' | 'done' | 'error' };
      }
      const set = (_value: unknown) => {};
      const saveSidebarSnapshot = (_rows: SidebarSnapshotRow[]) => {};
      export const store = {
        applySidebarSnapshot: (snapshot: SidebarSnapshotRow[]) => {
          set({ rows: snapshot });
          saveSidebarSnapshot(snapshot);
        },
        beginSidebarCommand: () => set({ pendingThreadCommands: {} }),
      };
    `,
  );
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx'),
    `import { store } from '${fixtureImport('..', '..', 'stores', 'sidebarProjectionStore')}'; export const ThreadSidebar = () => store;`,
  );
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/ThreadItem.tsx'),
    `export const ThreadItem = () => null;`,
  );
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/thread-utils.ts'),
    `export const sortRows = (rows) => rows;`,
  );
  return root;
}

test('legal Chat runtime messages + catStatuses writes stay outside the Sidebar boundary', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/stores/chatStore.ts'),
    `const set = (_value) => {}; set({ threadStates: { t: { messages: [], catStatuses: {} } } });`,
  );
  assert.deepEqual(checkSidebarProjectionBoundary(root), []);
});

test('direct canonical row replacement outside applySidebarSnapshot is rejected', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/utils/illegal.ts'),
    `import { useSidebarProjectionStore } from '${fixtureImport('..', 'stores', 'sidebarProjectionStore')}';
     useSidebarProjectionStore.setState({ rows: [] });`,
  );
  assert.match(checkSidebarProjectionBoundary(root).join('\n'), /canonical rows/i);
});

test('functional canonical row replacement outside applySidebarSnapshot is rejected', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/utils/illegal-functional.ts'),
    `import { useSidebarProjectionStore } from '${fixtureImport('..', 'stores', 'sidebarProjectionStore')}';
     useSidebarProjectionStore.setState(() => ({ rows: [] }));`,
  );
  assert.match(checkSidebarProjectionBoundary(root).join('\n'), /canonical rows/i);
});

test('legacy liveness import in the Sidebar render tree is rejected', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/ThreadItem.tsx'),
    `import { useThreadLiveness } from '${fixtureImport('..', '..', '..', 'hooks', 'useThreadScopedSelectors')}';
     export const ThreadItem = () => useThreadLiveness('t');`,
  );
  assert.match(checkSidebarProjectionBoundary(root).join('\n'), /legacy liveness/i);
});

test('legacy thread list and lastActivity reads in the Sidebar render tree are rejected', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx'),
    `import { useChatStore } from '${fixtureImport('..', '..', 'stores', 'chatStore')}';
     export const ThreadSidebar = () => useChatStore((state) => state.threads).map((row) => row.lastActivity);`,
  );
  const errors = checkSidebarProjectionBoundary(root).join('\n');
  assert.match(errors, /legacy chatStore\.threads/i);
  assert.match(errors, /legacy lastActivity/i);
});

test('field overlay and named draft adapter remain legal', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/sidebar-draft-decoration.ts'),
    `import { useChatStore } from '${fixtureImport('..', '..', 'stores', 'chatStore')}';
     export const useSidebarDraftDecoration = (id) => useChatStore((s) => s.threadStates[id]?.hasDraft);`,
  );
  assert.deepEqual(checkSidebarProjectionBoundary(root), []);
});

test('conversation activity cannot be reused as Sidebar lifecycle evidence', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/api/src/routes/sidebar-presence-projection.ts'),
    `import type { ThreadParticipantActivity } from '${fixtureImport('..', 'stores', 'ThreadStore.js')}';
     export const composeSidebarPresence = (threadStore) =>
       threadStore.getParticipantsWithActivityBatch([]) as Map<string, ThreadParticipantActivity[]>;`,
  );
  const errors = checkSidebarProjectionBoundary(root).join('\n');
  assert.match(errors, /conversation activity imported as presence truth/i);
  assert.match(errors, /conversation activity read as presence truth/i);
});

test('working elapsed cannot be derived from C7 lastActiveAt', (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, 'packages/web/src/components/ThreadSidebar/ThreadItem.tsx'),
    `export const formatWorkingElapsed = (lastActiveAt) => Date.now() - lastActiveAt;`,
  );
  assert.match(
    checkSidebarProjectionBoundary(root).join('\n'),
    /working elapsed.*lastActiveAt|lastActiveAt.*working elapsed/i,
  );
});
