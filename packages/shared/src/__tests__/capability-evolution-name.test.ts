import { describe, expect, it } from 'vitest';
import { reduceEvolutionProgramEvent, replayEvolutionProgramEvents } from '../types/capability-evolution.js';
import { evolutionProgramDisplayNameSchema, evolutionProgramTitle } from '../types/capability-evolution-name.js';
import { activeCycleEvents, envelope, terminalEvents } from './capability-evolution.fixtures.js';

describe('F311 Program naming metadata', () => {
  it.each([
    activeCycleEvents,
    terminalEvents,
  ])('preserves every cycle and effect fact when naming an existing Program', (events) => {
    const before = replayEvolutionProgramEvents(events());
    if (!before) throw new Error('Fixture must create a Program');
    const after = reduceEvolutionProgramEvent(
      before,
      envelope(before.program.sequence, { type: 'program_named', displayName: '讲解能力' }),
    );
    expect(after.cycles).toEqual(before.cycles);
    expect(after.program).toEqual({
      ...before.program,
      displayName: '讲解能力',
      sequence: before.program.sequence + 1,
      updatedAt: envelope(before.program.sequence, { type: 'program_named', displayName: '讲解能力' }).occurredAt,
    });
  });
  it('round-trips explicit names while legacy events remain readable without a guessed title', () => {
    const [created] = activeCycleEvents();
    if (!created || created.event.type !== 'program_created') throw new Error('Fixture must start with creation');
    const named = replayEvolutionProgramEvents([{ ...created, event: { ...created.event, displayName: '讲解能力' } }]);
    expect(named?.program.displayName).toBe('讲解能力');
    const legacy = replayEvolutionProgramEvents([created]);
    expect(legacy?.program.displayName).toBeUndefined();
    expect(evolutionProgramTitle({ programId: 'evolution-program:12345678' })).toBe('未命名项目');
  });
  it('labels the verified source conversation as context, not as an invented project name', () => {
    const program = { programId: 'evolution-program:12345678' };
    const origin = { threadId: 'thread-review', title: '让审阅更贴近原始需求' };
    expect(evolutionProgramTitle(program, origin)).toBe('来自「让审阅更贴近原始需求」');
    expect(evolutionProgramTitle({ ...program, displayName: '审阅改进' }, origin)).toBe('审阅改进');
  });
  it.each(['', ' \n ', 'bad\nname', 'bad\tname', 'x'.repeat(121)])('rejects an unreadable Program name', (name) => {
    expect(evolutionProgramDisplayNameSchema.safeParse(name).success).toBe(false);
  });
});
