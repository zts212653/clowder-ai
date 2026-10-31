import { describe, expect, it } from 'vitest';
import { type CopyGrammar, type CopySamples, type CopyTree, defineShellCopy, type ShellCopy } from '../shell-copy';
import { checkShellCopyParity } from './shell-copy-parity-check';

/** A namespace built without the compiler's help, so the cases the types already refuse can still be shown to this check. */
function raw(zh: CopyTree, en: CopyTree, samples: CopySamples = {}, grammar: CopyGrammar = {}): ShellCopy<CopyTree> {
  return { kind: 'shell-copy', zh, en, samples, grammar };
}

/** What the check says when English ignores a value Chinese uses, including the line that tells the author how to declare grammar. */
function dropped(path: string, label: string): string {
  return `${path}: argument ${label} changes the Chinese text but not the English — the English ignores a value the Chinese uses (if the value only picks wording, such as a gender, and is not itself shown, declare it: grammar: { '${path}': ['${label}'] })`;
}

const good = raw(
  {
    title: '成员',
    tool: 'Git',
    group: { empty: '暂无内容' },
    running: (count: number) => `运行中 ${count}`,
    between: (from: string, to: string) => `${from} → ${to}`,
    online: (who: string) => `${who} 在线`,
  },
  {
    title: 'Members',
    tool: 'Git',
    group: { empty: 'Nothing here yet' },
    running: (count: number) => `${count} running`,
    between: (from: string, to: string) => `${from} → ${to}`,
    online: (who: string) => `${who} is online`,
  },
  {
    running: [[0], [1], [12]],
    between: [
      ['A', 'B'],
      ['C', 'D'],
    ],
    // A person's name is typed by a person: it may be Chinese inside an English sentence.
    online: [['烁烁'], ['小星星']],
  },
);

describe('the consistency check behind AC-B8', () => {
  it('passes a namespace whose two languages agree — including a name that is the same in both (Git)', () => {
    expect(checkShellCopyParity(good)).toEqual([]);
  });

  it('names a key that exists in only one language, at any depth', () => {
    const problems = checkShellCopyParity(
      raw({ a: '甲', group: { b: '乙', c: '丙' } }, { a: 'A', group: { b: 'B' }, extra: 'E' }),
    );
    expect(problems).toContain('group.c: zh is text but en is missing');
    expect(problems).toContain('extra: zh is missing but en is text');
  });

  it('catches an extra English key that the compiler let through because the English object was declared first', () => {
    const en = { title: 'Members', extra: 'Extra' };
    // Compiles: the excess-property check only applies to an inline literal. The namespace check is the backstop.
    const copy = defineShellCopy({ zh: { title: '成员' }, en });
    expect(checkShellCopyParity(copy as ShellCopy<CopyTree>)).toEqual(['extra: zh is missing but en is text']);
  });

  it('names a leaf that is text in one language and a template or a group in the other', () => {
    const problems = checkShellCopyParity(
      raw({ a: '甲', b: (n: number) => `${n}`, c: { d: '丁' } }, { a: (n: number) => `${n}`, b: 'B', c: 'C' }, {}),
    );
    expect(problems.some((problem) => problem.startsWith('a: zh is text but en is template'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('b: zh is template'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('c: zh is group but en is text'))).toBe(true);
  });

  describe('a language that drops a value the other uses', () => {
    it('catches a second parameter that only one language reads, when the samples vary it', () => {
      const problems = checkShellCopyParity(
        raw(
          { between: (from: string, to: string) => `${from} → ${to}` },
          { between: (from: string) => `from ${from}` },
          {
            between: [
              ['A', 'B'],
              ['C', 'D'],
            ],
          },
        ),
      );
      expect(problems).toEqual([dropped('between', '1')]);
    });

    it('catches a default parameter that .length cannot see: zh reads it, en takes none at all', () => {
      const problems = checkShellCopyParity(
        raw({ count: (n = 0) => `共 ${n} 项` }, { count: () => 'Items' }, { count: [[0], [12]] }),
      );
      expect(problems).toEqual([dropped('count', '0')]);
    });

    it('catches a rest parameter the same way', () => {
      const problems = checkShellCopyParity(
        raw({ tags: (...names: string[]) => names.join('、') }, { tags: () => 'Tags' }, { tags: [['a'], ['b']] }),
      );
      expect(problems).toEqual([dropped('tags', '0')]);
    });

    it('lets English vary where Chinese has no grammatical number: a Chinese neutral label against an English singular / plural pair', () => {
      const problems = checkShellCopyParity(
        raw(
          { onlineLabel: (count: number): string => (count === 0 ? '没有在线成员' : '在线成员') },
          {
            onlineLabel: (count: number): string =>
              count === 0 ? 'No members online' : count === 1 ? 'Member online' : 'Members online',
          },
          { onlineLabel: [[0], [1], [2]] },
        ),
      );
      expect(problems).toEqual([]);
    });

    it('is one-directional by design: it cannot tell a Chinese template that ignores a value from English grammar, so it does not try', () => {
      const problems = checkShellCopyParity(
        raw({ total: () => '全部' }, { total: (n: number) => `Total ${n}` }, { total: [[0], [3]] }),
      );
      expect(problems).toEqual([]);
    });

    it('looks inside an object argument, field by field', () => {
      const missing = checkShellCopyParity(
        raw(
          { row: ({ count, name }: { count: number; name: string }) => `${name}：${count}` },
          { row: ({ count }: { count: number; name: string }) => `${count}` },
          {
            row: [[{ count: 1, name: 'a' }], [{ count: 2, name: 'b' }]],
          },
        ),
      );
      expect(missing).toEqual([dropped('row', '0.name')]);
      const same = checkShellCopyParity(
        raw(
          { row: ({ count, name }: { count: number; name: string }) => `${name}：${count}` },
          { row: ({ count, name }: { count: number; name: string }) => `${name}: ${count}` },
          {
            row: [[{ count: 1, name: 'a' }], [{ count: 2, name: 'b' }]],
          },
        ),
      );
      expect(same).toEqual([]);
    });

    it('asks for samples that differ, because a value that never varies cannot be seen to be dropped', () => {
      const problems = checkShellCopyParity(
        raw({ n: (c: number) => `${c}` }, { n: (c: number) => `${c}` }, { n: [[1], [1]] }),
      );
      expect(problems).toEqual([
        'n: argument 0 takes the same value in every sample — add a sample that differs, or a dropped value cannot be seen',
      ]);
    });
  });

  describe('a grammatical choice, declared', () => {
    const gendered = {
      zh: { online: (gender: 'female' | 'male'): string => (gender === 'female' ? '她已上线' : '他已上线') },
      en: { online: (): string => 'They are online' },
    };
    const genders = { online: [['female'], ['male']] };

    it('refuses a Chinese pronoun that English does not mirror until the value is declared grammar, then accepts it', () => {
      expect(checkShellCopyParity(raw(gendered.zh, gendered.en, genders))).toEqual([dropped('online', '0')]);
      expect(checkShellCopyParity(raw(gendered.zh, gendered.en, genders, { online: ['0'] }))).toEqual([]);
    });

    it('works through defineShellCopy, which is how a dictionary file states it', () => {
      const copy = defineShellCopy(gendered, { samples: genders, grammar: { online: ['0'] } });
      expect(checkShellCopyParity(copy)).toEqual([]);
      expect(copy.grammar).toEqual({ online: ['0'] });
      expect(Object.isFrozen(copy.grammar.online)).toBe(true);
      expect(defineShellCopy({ zh: { a: '甲' }, en: { a: 'A' } }).grammar).toEqual({});
    });

    it('excuses only the declared argument: a name dropped beside it is still caught', () => {
      const problems = checkShellCopyParity(
        raw(
          { online: (gender: string, name: string): string => `${name}${gender === 'female' ? '她' : '他'}已上线` },
          { online: (): string => 'They are online' },
          {
            online: [
              ['female', 'a'],
              ['male', 'b'],
            ],
          },
          { online: ['0'] },
        ),
      );
      expect(problems).toEqual([dropped('online', '1')]);
    });

    it('declares a field of an object argument by its path, and still catches another field being dropped', () => {
      const zh = {
        row: ({ gender, name }: { gender: string; name: string }): string =>
          `${name}${gender === 'female' ? '她' : '他'}已上线`,
      };
      const samples = {
        row: [[{ gender: 'female', name: 'a' }], [{ gender: 'male', name: 'b' }]],
      };
      const keepsName = {
        row: ({ name }: { gender: string; name: string }): string => `${name} is online`,
      };
      const dropsName = {
        row: (): string => 'They are online',
      };
      expect(checkShellCopyParity(raw(zh, keepsName, samples, { row: ['0.gender'] }))).toEqual([]);
      expect(checkShellCopyParity(raw(zh, dropsName, samples, { row: ['0.gender'] }))).toEqual([
        dropped('row', '0.name'),
      ]);
    });

    it('does not let a declaration hide content: a value the Chinese prints is not a choice of wording', () => {
      const name = checkShellCopyParity(
        raw(
          { online: (who: string): string => `${who} 已上线` },
          { online: (): string => 'Online' },
          { online: [['烁烁'], ['小星星']] },
          { online: ['0'] },
        ),
      );
      expect(name).toEqual([
        'online: argument 0 is declared a grammatical choice, but the Chinese prints the value itself — that makes it content: take it out of grammar and have the English use it',
      ]);
      const count = checkShellCopyParity(
        raw(
          { total: (n: number): string => `共 ${n} 项` },
          { total: (): string => 'Items' },
          { total: [[2], [30]] },
          { total: ['0'] },
        ),
      );
      expect(count).toEqual([
        'total: argument 0 is declared a grammatical choice, but the Chinese prints the value itself — that makes it content: take it out of grammar and have the English use it',
      ]);
    });

    it('does not mistake fixed Chinese text that happens to contain the same digit for the value being printed', () => {
      const problems = checkShellCopyParity(
        raw(
          { step: (kind: 1 | 2): string => (kind === 1 ? '第1步，她来做' : '第1步，他来做') },
          { step: (): string => 'Step 1, they will do it' },
          { step: [[1], [2]] },
          { step: ['0'] },
        ),
      );
      expect(problems).toEqual([]);
    });

    it('reports a declaration that names no real argument or no template, instead of silently excusing nothing', () => {
      const wrongArgument = checkShellCopyParity(raw(gendered.zh, gendered.en, genders, { online: ['0', '1'] }));
      expect(wrongArgument).toEqual(['online: grammar names argument 1, which no sample has']);
      const noTemplate = checkShellCopyParity(
        raw({ title: '成员', ...gendered.zh }, { title: 'Members', ...gendered.en }, genders, {
          online: ['0'],
          title: ['0'],
        }),
      );
      expect(noTemplate).toEqual(['title: grammar for something that is not a template']);
    });
  });

  it('catches English that was never translated, including fullwidth punctuation, but allows English names in Chinese', () => {
    const problems = checkShellCopyParity(raw({ a: 'Git 状态', b: '好' }, { a: 'Git status', b: 'Done，ok' }));
    expect(problems).toEqual(['b: en still has Chinese: "Done，ok"']);
  });

  it('catches Chinese or fullwidth punctuation that a TEMPLATE prints, but not a name that was handed in', () => {
    const problems = checkShellCopyParity(
      raw(
        { running: (n: number) => (n === 0 ? '暂无运行' : `运行 ${n}`) },
        { running: (n: number) => (n === 0 ? '暂无运行' : `Running，${n}`) },
        { running: [[0], [2]] },
      ),
    );
    expect(problems).toEqual([
      'running: en([0]) printed Chinese: "暂无运行"',
      'running: en([2]) printed Chinese: "Running，2"',
    ]);
  });

  it('catches placeholders that were never filled and empty words', () => {
    const problems = checkShellCopyParity(
      raw({ a: '共 {count} 项', b: '', c: '请输入 %s' }, { a: 'Total {count} items', b: 'B', c: 'Enter %s' }),
    );
    expect(problems).toContain('a: zh has an unfilled placeholder: "共 {count} 项"');
    expect(problems).toContain('a: en has an unfilled placeholder: "Total {count} items"');
    expect(problems).toContain('b: zh is empty');
    expect(problems).toContain('c: zh has an unfilled placeholder: "请输入 %s"');
  });

  it('refuses a key that holds a dot, because a sample path could not tell it from a nested group', () => {
    const problems = checkShellCopyParity(
      raw({ 'a.b': '甲', group: { 'c.d': '乙' } }, { 'a.b': 'A', group: { 'c.d': 'B' } }),
    );
    expect(problems).toEqual([
      'a.b: key contains a dot — samples address templates by dotted path',
      'group.c.d: key contains a dot — samples address templates by dotted path',
    ]);
  });

  it('requires every template to be called by the test, and every sample to belong to a template', () => {
    const noSamples = raw({ n: (c: number) => `${c}` }, { n: (c: number) => `${c}` });
    expect(checkShellCopyParity(noSamples)).toEqual([
      'n: template with no samples — list the argument lists the test should call it with',
    ]);
    const stray = raw({ a: '甲' }, { a: 'A' }, { a: [[1]], nothere: [[1]] });
    expect(checkShellCopyParity(stray)).toEqual([
      'a: samples for something that is not a template',
      'nothere: samples for something that is not a template',
    ]);
  });

  it('catches a template that prints "undefined" or nothing for its own samples (the wrong arguments, or a broken branch)', () => {
    const problems = checkShellCopyParity(
      raw(
        { n: (count: number) => `${count}`, m: (who: { name: string }) => `${who.name} 在线` },
        { n: (count: number) => (count > 1 ? `${count}` : ''), m: (who: { name: string }) => `${who.name} online` },
        { n: [[2], [1]], m: [[{ nme: 'typo' }], [{ nme: 'other' }]] },
      ),
    );
    expect(problems).toContain('n: en([1]) printed ""');
    expect(problems).toContain('m: zh([{"nme":"typo"}]) printed "undefined 在线"');
    expect(problems).toContain('m: en([{"nme":"typo"}]) printed "undefined online"');
  });

  it('reports a template that throws on its own samples instead of crashing the check', () => {
    const problems = checkShellCopyParity(
      raw(
        {
          n: () => {
            throw new Error('boom');
          },
        },
        { n: (c: number) => `${c}` },
        { n: [[1], [2]] },
      ),
    );
    expect(problems).toContain('n: zh([1]) threw: Error: boom');
  });
});
