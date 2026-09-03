// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const chatContainer = readFileSync(resolve(testDir, '../ChatContainer.tsx'), 'utf8');
const threadChatSurface = readFileSync(resolve(testDir, '../thread-chat/ThreadChatSurface.tsx'), 'utf8');
const connectionStatus = readFileSync(resolve(testDir, '../../hooks/useConnectionStatus.ts'), 'utf8');
const splitPane = readFileSync(resolve(testDir, '../SplitPaneView.tsx'), 'utf8');

describe('runtime update guard wiring', () => {
  it('gates every forwarding affordance on forwarding admission, not on composer readonly', () => {
    expect(threadChatSurface).toMatch(
      /<MessageSelectionToolbar[\s\S]*forwardingDisabled=\{connectionStatus\.forwardingBlocked\}/,
    );
    expect(threadChatSurface).toContain('forwardingDisabled={connectionStatus.forwardingBlocked}');
    expect(threadChatSurface).toContain('open={selection.selectionForwardOpen && !connectionStatus.forwardingBlocked}');
    expect(threadChatSurface).toContain('admissionBlocked={connectionStatus.forwardingBlocked}');
  });

  it('keeps composer writes on their own flag so an unverified deploy cannot brick sending', () => {
    // Regression guard for the 2026-08-17 outage: one conflated flag meant an
    // absent Web build stamp took plain sending down with forwarding.
    expect(threadChatSurface).toContain('isReadonly={connectionStatus.isReadonly}');
    expect(threadChatSurface).toContain('disabled={connectionStatus.isReadonly}');
    expect(splitPane).toContain('disabled={!splitPaneTargetId || isReadonly}');
    expect(threadChatSurface).not.toContain('forwardingDisabled={connectionStatus.isReadonly}');
    expect(threadChatSurface).not.toContain('admissionBlocked={connectionStatus.isReadonly}');
  });

  it('shows the reload gate only for a detected mismatch, the one state a reload recovers', () => {
    expect(chatContainer).toContain('connectionStatus.updateRequired && <RuntimeUpdateRequiredDialog');
    expect(connectionStatus).toContain('composerReadonly: revision.updateRequired || connectivityDown');
    expect(connectionStatus).toContain(
      'forwardingBlocked: !revision.verified || revision.updateRequired || connectivityDown',
    );
  });

  it('rechecks the deployment revision at the socket reconnect boundary', () => {
    expect(connectionStatus).toMatch(/if \(socketConnected === true\) void runProbe\(\)/);
  });
});
