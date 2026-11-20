import { appendLocalImagePathHints } from './image-cli-bridge.js';

export {
  extractTextContent,
  extractThinkingContent,
  type KimiPrintMessage,
  parseToolArguments,
  parseUsage,
  readSessionIdFromMessage,
} from '@clowder-ai/agent-access/runtime/kimi-event-parser';

export function buildKimiPrompt(prompt: string, imagePaths: readonly string[] = []): string {
  return appendLocalImagePathHints(prompt, imagePaths);
}
