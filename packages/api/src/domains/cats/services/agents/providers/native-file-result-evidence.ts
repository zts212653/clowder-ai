/** Absolute paths reported by a successful native file tool, never model arguments or session cwd. */
export interface NativeFileResultEvidence {
  readonly kind: 'claude-post-tool-result';
  readonly absolutePath: string;
}

export function readNativeFileResultEvidence(value: unknown): NativeFileResultEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const evidence = value as Record<string, unknown>;
  const path = evidence.absolutePath;
  if (
    evidence.kind !== 'claude-post-tool-result' ||
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 4096 ||
    path.includes('\0')
  )
    return undefined;
  return { kind: 'claude-post-tool-result', absolutePath: path };
}

export function claudePostToolFileEvidence(entry: Record<string, unknown>): NativeFileResultEvidence | undefined {
  if (entry.hook_event_name !== 'PostToolUse' || (entry.tool_name !== 'Write' && entry.tool_name !== 'Edit'))
    return undefined;
  if (!entry.tool_response || typeof entry.tool_response !== 'object') return undefined;
  const response = entry.tool_response as Record<string, unknown>;
  if (response.success === false || response.is_error === true) return undefined;
  return readNativeFileResultEvidence({ kind: 'claude-post-tool-result', absolutePath: response.filePath });
}
