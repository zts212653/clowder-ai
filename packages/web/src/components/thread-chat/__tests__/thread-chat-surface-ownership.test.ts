import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const conciergeRoot = resolve(sourceRoot, 'components/concierge');
const threadChatRoot = resolve(sourceRoot, 'components/thread-chat');

const legacyCore = [
  'useConciergeMessages.ts',
  'useConciergeQueue.ts',
  'useConciergePanelLiveness.ts',
  'ConciergePanelConversation.tsx',
  'ConciergeMessageContent.tsx',
] as const;

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return productionSources(absolutePath);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [absolutePath];
  });
}

describe('ThreadChatSurface ownership', () => {
  it('keeps the companion conversation in canonical full Chat after retiring its compact web shell', () => {
    expect(existsSync(resolve(threadChatRoot, 'ThreadChatSurface.tsx'))).toBe(true);

    const fullAdapter = readFileSync(resolve(sourceRoot, 'components/ChatContainer.tsx'), 'utf8');
    expect(fullAdapter).toMatch(/<ThreadChatSurface\b/);
    expect(existsSync(resolve(conciergeRoot, 'ConciergePanel.tsx'))).toBe(false);
    expect(readFileSync(resolve(threadChatRoot, 'ThreadChatSurface.tsx'), 'utf8')).toContain(
      'useCompanionConversation',
    );
  });

  it('deletes the legacy mini-chat core instead of retaining a fallback', () => {
    expect(legacyCore.filter((path) => existsSync(resolve(conciergeRoot, path)))).toEqual([]);
  });

  it('keeps conversation plumbing out of the compact adapter tree', () => {
    const forbiddenTreePatterns = [
      /['"`]\/api\/messages(?:\?|['"`])/,
      /\/api\/threads\/[^'"`]*\/queue/,
      /from ['"]@\/hooks\/useSocket['"]/,
      /from ['"]@\/hooks\/useChatHistory['"]/,
      /from ['"]@\/hooks\/useSendMessage['"]/,
      /\buseConciergeMessages\b/,
      /\buseConciergeQueue\b/,
      /\buseConciergePanelLiveness\b/,
    ];

    const offenders = productionSources(conciergeRoot).flatMap((absolutePath) => {
      const source = readFileSync(absolutePath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return forbiddenTreePatterns.some((pattern) => pattern.test(source))
        ? [relative(sourceRoot, absolutePath).replaceAll('\\', '/')]
        : [];
    });

    expect(offenders).toEqual([]);

    const companionPresentation = readFileSync(resolve(conciergeRoot, 'useCompanionConversation.tsx'), 'utf8');
    expect(companionPresentation).not.toMatch(/\buseSocket\b|\buseChatHistory\b|\buseSendMessage\b/);
  });

  it('keeps the normal full and compact send lifecycle inside ThreadChatSurface', () => {
    const sendHookConsumers = productionSources(sourceRoot)
      .filter((absolutePath) => /\buseSendMessage\(/.test(readFileSync(absolutePath, 'utf8')))
      .map((absolutePath) => relative(sourceRoot, absolutePath).replaceAll('\\', '/'))
      .sort();

    expect(sendHookConsumers).toEqual([
      'components/PlanBoardPanel.tsx',
      'components/SplitPaneView.tsx',
      // The root landing owns a pre-thread, idempotent create+first-message
      // transaction; it cannot enter ThreadChatSurface before a thread exists.
      'components/new-conversation/useNewConversationAdmission.ts',
      'components/thread-chat/ThreadChatSurface.tsx',
      'hooks/useSendMessage.ts',
    ]);
    expect(readFileSync(resolve(sourceRoot, 'components/ChatContainer.tsx'), 'utf8')).not.toMatch(/\buseSendMessage\b/);
  });
});
