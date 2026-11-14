import { materializableClaimPayloadSchema } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { personClaimText } from '../person-claim-presentation';

const emptyValues = [
  { name: 'native array', value: [] },
  { name: 'native object', value: {} },
  { name: 'serialized array', value: '[]' },
  { name: 'serialized object', value: '{}' },
  { name: 'nested collections', value: [{}, []] },
  { name: 'nested empty leaves', value: { details: [null, '', '  '], refs: {} } },
  { name: 'null', value: null },
  { name: 'empty string', value: '' },
  { name: 'whitespace', value: '  ' },
];
const fact = (value: unknown) => ({
  kind: 'reported_fact' as const,
  predicate: 'birth_date',
  value,
  assertedBy: 'owner' as const,
});

it.each(emptyValues)('gives neutral readable text for legal $name', ({ value }) => {
  const payload = fact(value);
  expect(materializableClaimPayloadSchema.safeParse(payload).success).toBe(true);
  expect(personClaimText(payload)).toBe('内容为空');
});

it('connects only visible values, preserving zero and false without punctuation from empty collections', () => {
  const value = { empty: [], values: [false, 0, {}, '成都', null, ' '] };
  for (const input of [value, JSON.stringify(value)]) {
    expect(personClaimText(fact(input))).toBe('false，0，成都');
  }
  expect(personClaimText({ ...fact({}), predicate: '备注' })).toBe('备注：内容为空');
});

it.each([
  ['birth_date', '1988-02-03', 'birth date：1988-02-03'],
  ['known_agent_tool_experience', 'Task Buddy', 'known agent tool experience：Task Buddy'],
  ['candidate-status', 'new candidate, call next week', 'candidate status：new candidate, call next week'],
  ['currentRole', 'designer', 'current role：designer'],
  ['HTTPToolExperience', 'CLI', 'http tool experience：CLI'],
  ['isAvailable', false, 'is available：no'],
  ['apps_created', 0, 'apps created：0'],
  ['favorite_tools', ['CLI', 'Editor'], 'favorite tools：CLI，Editor'],
] as const)('retains readable context for a non-Chinese %s value', (predicate, value, expected) => {
  expect(personClaimText({ ...fact(value), predicate })).toBe(expected);
});

it('labels object fields and boolean values without changing the native or serialized payload', () => {
  const value = { traditionalSoftwareDevelopmentBackground: false, appsDevelopedWithCatAgents: 3 };
  for (const input of [value, JSON.stringify(value)]) {
    const payload = { ...fact(input), predicate: 'self_reported_agent_app_experience' };
    const before = JSON.stringify(payload);
    expect(personClaimText(payload)).toBe(
      'self reported agent app experience：traditional software development background no，apps developed with cat agents 3',
    );
    expect(JSON.stringify(payload)).toBe(before);
  }
  expect(personClaimText(fact({ year: 1988, month: 2 }))).toBe('birth date：year 1988，month 2');
});

it('keeps Chinese content, approved wording, assessments and redaction on their existing paths', () => {
  const cases = [
    { predicate: 'current_role', value: '产品经理', expected: '产品经理' },
    { predicate: 'travel_base', value: { city: '成都', since: 2020 }, expected: '成都，2020' },
    { predicate: 'travelBase', value: '{"city":"成都","since":2020}', expected: '成都，2020' },
    { predicate: '老家', value: '成都', expected: '老家：成都' },
    { predicate: '工具', value: 'CLI', expected: '工具：CLI' },
  ];
  for (const { predicate, value, expected } of cases) {
    expect(personClaimText({ ...fact(value), predicate })).toBe(expected);
  }
  expect(personClaimText(fact('1988-02-03'), '  主人批准的原句  ')).toBe('  主人批准的原句  ');
  expect(
    personClaimText({
      kind: 'user_assessment',
      statement: 'willing to listen',
      stance: 'endorsed',
      assertedBy: 'owner',
    }),
  ).toBe('willing to listen');
  expect(personClaimText({ kind: 'redacted' }, '旧原句')).toBe('这条内容已遗忘');
});
