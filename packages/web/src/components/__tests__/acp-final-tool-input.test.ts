import { describe, expect, it } from 'vitest';
import { toCliEvents } from '../cli-output/toCliEvents';

describe('final ACP tool input in the production CLI history adapter', () => {
  it('does not merge final input across native parent execution scopes', () => {
    const row = (id: string, parent: string, type: 'tool_use' | 'tool_result') => ({
      id,
      type,
      label: 'codex → Read',
      executionRef: 'run',
      toolUseId: 'same-native-id',
      toolParentUseId: parent,
      timestamp: 1,
    });
    const projected = toCliEvents(
      [
        row('use-a', 'parent-a', 'tool_use'),
        row('use-b', 'parent-b', 'tool_use'),
        { ...row('result-a', 'parent-a', 'tool_result'), inputDetail: '{"path":"a"}' },
        { ...row('result-b', 'parent-b', 'tool_result'), inputDetail: '{"path":"b"}' },
      ],
      undefined,
    );
    expect(projected[0].detail).toBe('{"path":"a"}');
    expect(projected[1].detail).toBe('{"path":"b"}');
  });
  for (const early of [undefined, '{"command":"ech"}']) {
    it(`projects final input instead of the initial snapshot (${String(early)})`, () => {
      const original = [
        {
          id: 'use',
          type: 'tool_use' as const,
          label: 'codex → Bash',
          toolUseId: 'native',
          executionRef: 'run-1',
          timestamp: 1,
          detail: early,
        },
        {
          id: 'result',
          type: 'tool_result' as const,
          label: 'codex ← result',
          toolUseId: 'native',
          executionRef: 'run-1',
          timestamp: 2,
          detail: 'complete',
          inputDetail: '{"command":"echo complete"}',
        },
      ];
      const projected = toCliEvents(original, undefined);
      expect(projected).toHaveLength(2);
      expect(projected[0].label).toBe('Bash echo complete');
      expect(projected[0].detail).toBe('{"command":"echo complete"}');
      expect(projected[1].detail).toBe('complete');
      expect(original[0].detail).toBe(early);
    });
  }
});
