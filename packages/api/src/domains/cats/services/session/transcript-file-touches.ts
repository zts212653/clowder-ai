import { readNativeFileResultEvidence } from '../agents/providers/native-file-result-evidence.js';

export interface TranscriptFileTouch {
  path: string;
  ops: string[];
}

export function recordFilesTouched(
  filePaths: Map<string, Set<string>>,
  evt: Record<string, unknown>,
  evtName: string | undefined,
): void {
  if (evt.type !== 'tool_use' || typeof evtName !== 'string') return;
  const input = (evt.toolInput ?? evt.input) as Record<string, unknown> | undefined;
  if (!input) return;
  const opName = toolNameToOp(evtName);
  const nativeResult =
    evtName === 'Write' || evtName === 'Edit' ? readNativeFileResultEvidence(evt.fileResultEvidence) : undefined;
  const paths = nativeResult ? [nativeResult.absolutePath] : extractToolPaths(input, evtName);
  for (const path of paths) {
    const ops = filePaths.get(path) ?? new Set<string>();
    if (opName) ops.add(opName);
    filePaths.set(path, ops);
  }
}

export function materializeFilesTouched(filePaths: Map<string, Set<string>>): TranscriptFileTouch[] {
  return [...filePaths.entries()].map(([path, ops]) => ({ path, ops: [...ops] }));
}

function toolNameToOp(name: string): string | null {
  switch (name.toLowerCase()) {
    case 'write':
      return 'create';
    case 'edit':
    case 'file_change':
      return 'edit';
    case 'delete':
      return 'delete';
    case 'read':
    case 'grep':
    case 'glob':
      return 'read';
    default:
      return null;
  }
}

function extractToolPaths(input: Record<string, unknown>, toolName: string): string[] {
  const directPath = (input.file_path ?? input.path) as string | undefined;
  if (directPath && typeof directPath === 'string') return [directPath];
  if (toolName.toLowerCase() !== 'file_change' || !Array.isArray(input.changes)) return [];
  return input.changes
    .map((change) => {
      if (typeof change === 'string') return change;
      if (change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string') {
        return (change as { path: string }).path;
      }
      return null;
    })
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}
