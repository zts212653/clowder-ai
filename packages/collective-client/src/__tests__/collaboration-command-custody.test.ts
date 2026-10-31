import { expect, it } from 'vitest';
import { acknowledgeCollaborationCommand, prepareCollaborationCommand } from '../collaboration-command-custody.js';

it('reuses one request id after response loss and releases only the accepted collaboration command', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  let sequence = 0;
  const createId = () => `request-${++sequence}`;
  const first = prepareCollaborationCommand(
    storage,
    'collective:human',
    { kind: 'propose', source: 'event-a' },
    createId,
  );
  expect(
    prepareCollaborationCommand(storage, 'collective:human', { kind: 'propose', source: 'event-a' }, createId),
  ).toBe(first);
  const second = prepareCollaborationCommand(storage, 'collective:human', { kind: 'commit', work: 'work-a' }, createId);
  expect(second).not.toBe(first);
  acknowledgeCollaborationCommand(storage, 'collective:human', first);
  expect(prepareCollaborationCommand(storage, 'collective:human', { kind: 'commit', work: 'work-a' }, createId)).toBe(
    second,
  );
});
