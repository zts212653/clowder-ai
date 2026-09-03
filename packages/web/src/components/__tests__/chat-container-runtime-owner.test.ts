import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentsRoot = resolve(process.cwd(), 'src/components');
const sourceRoot = resolve(process.cwd(), 'src');

function findProductionHookConsumers(directory: string, hookName: string, excludedSourcePaths: Set<string>): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    const sourcePath = relative(sourceRoot, absolutePath).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return findProductionHookConsumers(absolutePath, hookName, excludedSourcePaths);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (excludedSourcePaths.has(sourcePath)) return [];
    const source = readFileSync(absolutePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const hookCall = new RegExp(`\\b${hookName}\\s*\\(`, 'g');
    return source.match(hookCall)?.map(() => sourcePath) ?? [];
  });
}

function findProductionJsxElements(directory: string, elementName: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = resolve(directory, entry.name);
    const sourcePath = relative(sourceRoot, absolutePath).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return findProductionJsxElements(absolutePath, elementName);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    const source = readFileSync(absolutePath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const element = new RegExp(`<${elementName}(?:\\s|>)`, 'g');
    return source.match(element)?.map(() => sourcePath) ?? [];
  });
}

describe('chat runtime ownership', () => {
  it('keeps the socket hook in the AppShell provider instead of ChatContainer', () => {
    const chatContainer = readFileSync(resolve(componentsRoot, 'ChatContainer.tsx'), 'utf8');

    expect(chatContainer).not.toMatch(/from ['"]@\/hooks\/useSocket['"]/);
    expect(chatContainer).not.toMatch(/\buseSocket\s*\(/);
    expect(chatContainer).toMatch(/\buseThreadChatRuntime\s*\(/);
    expect(
      findProductionHookConsumers(sourceRoot, 'useSocket', new Set(['hooks/useSocket.ts', 'hooks/useSocket.types.ts'])),
    ).toEqual(['components/thread-chat/ThreadChatRuntimeProvider.tsx']);
  });

  it('keeps history admission behind the canonical history hook and one full-chat consumer', () => {
    expect(
      findProductionHookConsumers(
        sourceRoot,
        'useThreadChatHistoryAdmission',
        new Set(['components/thread-chat/ThreadChatRuntimeProvider.tsx']),
      ),
    ).toEqual(['hooks/useChatHistory.ts']);
    expect(findProductionHookConsumers(sourceRoot, 'useChatHistory', new Set(['hooks/useChatHistory.ts']))).toEqual([
      'components/thread-chat/ThreadChatExport.tsx',
      'components/thread-chat/ThreadChatSurface.tsx',
    ]);
    expect(findProductionJsxElements(sourceRoot, 'ThreadChatHistoryAdmissionProvider')).toEqual([
      'components/thread-chat/ThreadChatRuntimeProvider.tsx',
    ]);
  });

  it('restores durable rich-action confirmations in both full and compact adapters', () => {
    expect(
      findProductionHookConsumers(
        sourceRoot,
        'useConciergeConfirmations',
        new Set(['components/concierge/useConciergeConfirmations.ts']),
      ),
    ).toEqual(['components/ChatContainer.tsx', 'components/concierge/ConciergePanel.tsx']);
  });
});
