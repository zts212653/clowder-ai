type MicrophoneAccessIssue = 'permission-denied' | 'device-unavailable' | 'unsupported';

export type MicrophoneIssue =
  | { kind: MicrophoneAccessIssue }
  | { kind: 'no-signal' | 'no-transcript'; deviceLabel: string | null };

export function microphoneAccessIssue(error: unknown): MicrophoneAccessIssue | null {
  if (!error || typeof error !== 'object' || !('name' in error)) return null;
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'NotReadableError':
      return 'device-unavailable';
    default:
      return null;
  }
}
