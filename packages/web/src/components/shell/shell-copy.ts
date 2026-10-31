'use client';

/**
 * F322 AC-B6–B8 — how a v2 surface spells its words in both languages.
 *
 * One file per surface, named `<surface>.shell-copy.ts` and kept beside the page it words (`members/members.shell-copy.ts`,
 * `workspace-home/workspace-home.shell-copy.ts`), each exporting a `defineShellCopy({ zh, en })`. The dictionary is every file
 * with that name: it is found by listing, so adding a surface edits no shared file and two page authors never collide, and
 * `__tests__/shell-copy-namespaces.test.ts` checks them all. The Chinese tree is the shape; the English tree must have the
 * same keys, and every template (a function, for anything with a count, a name or a state) takes the same parameters in
 * both and uses the same values. At the call the compiler rejects, for an inline `en: { … }`, a missing key, an extra key, text
 * where zh has a template, and parameter types that do not fit. It does not enforce exact sameness when `en` is an object
 * declared beforehand (an extra key passes) or when a parameter type is merely wider; the namespace test is the backstop for
 * keys, and it also checks by behaviour that neither language ignores a value the other uses.
 *
 * What goes in: labels, tooltips, placeholders, empty states, operation feedback and accessible names of the new shell.
 * What does not: words typed by people or cats, file contents, real ids, model or tool names. Say a sentence with a count as
 * one template per language (`(n) => n === 1 ? '1 item' : \`${n} items\``), never as fragments joined in the page.
 *
 *     export const membersCopy = defineShellCopy(
 *       {
 *         zh: { title: '成员', running: (n: number) => `运行中 ${n}` },
 *         en: { title: 'Members', running: (n: number) => `${n} running` },
 *       },
 *       { samples: { running: [[0], [1], [12]] } },   // arguments the consistency test calls every template with
 *     );
 *
 * Every argument of a template is content that both languages must use — the check mixes the samples so that one value changes
 * at a time and fails when the Chinese changes and the English does not. English has grammar Chinese lacks and the reverse (a
 * gendered 她 / 他 against a neutral "They are online"); for an argument that only picks wording and is not itself shown,
 * declare it, and the English may ignore it:
 *
 *     defineShellCopy(
 *       { zh: { online: (gender: 'female' | 'male'): string => gender === 'female' ? '她已上线' : '他已上线' },
 *         en: { online: () => 'They are online' } },   // an English template that ignores its argument takes none
 *       { samples: { online: [['female'], ['male']] }, grammar: { online: ['0'] } },   // '0' = first argument, '1.gender' = a field
 *     );
 *
 * Write `: string` on a template that picks between literals, as above: without it TypeScript infers the Chinese return as the
 * union of those two literals, and then asks the English to return the same Chinese literals.
 *
 * The declaration is a statement a reviewer reads in the diff; the check only refuses a malformed one (an argument no sample has,
 * something that is not a template) and one the Chinese prints (a name or a count is content, not a choice of wording).
 *     // in a component:  const t = useShellCopy(membersCopy);  →  t.title, t.running(3)
 */

import { type ShellLanguage, useShellLanguage } from './shell-language';

/** A word, or a sentence with holes in it. Any parameters, but the same ones in both languages. */
export type CopyLeaf = string | ((...args: never[]) => string);

export interface CopyTree {
  readonly [key: string]: CopyLeaf | CopyTree;
}

/** For each template, by dotted path (`wait.awaiting.revision`), the argument lists the consistency test calls it with. */
export type CopySamples = Readonly<Record<string, ReadonlyArray<readonly unknown[]>>>;

/** One argument of a template as the consistency check names it: `0` for the first, `1.gender` for a field of the second. */
export type ArgumentRef = `${number}` | `${number}.${string}`;

/**
 * For each template, by dotted path, the arguments whose value only PICKS WORDS and is not itself shown — a gender that turns
 * 她 / 他 into "they", a plural class. The consistency check treats every other argument as content that both languages must
 * use; it excuses an English that ignores a declared one. It cannot tell grammar from content by itself, so this is the
 * author's statement, and what it checks is only that the statement is well formed: it names a real argument of a real
 * template, and the Chinese does not print the value (a printed value is content).
 */
export type CopyGrammar = Readonly<Record<string, ReadonlyArray<ArgumentRef>>>;

export interface ShellCopy<T extends CopyTree> {
  readonly kind: 'shell-copy';
  readonly zh: T;
  readonly en: T;
  readonly samples: CopySamples;
  readonly grammar: CopyGrammar;
}

function deepFreeze<V>(value: V): V {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * `en` is checked against the type of `zh` (`NoInfer`): for an inline literal, a missing key, an extra key, a text where zh has
 * a template, or a template whose parameter types do not fit is a compile error at the page author's own line. That is not
 * exact sameness — an English object declared beforehand may carry extra keys, and a wider parameter type is accepted — so
 * `__tests__/shell-copy-namespaces.test.ts` re-checks every namespace's keys and what each template does with its values.
 */
export function defineShellCopy<T extends CopyTree>(
  copy: { readonly zh: T; readonly en: NoInfer<T> },
  options: { readonly samples?: CopySamples; readonly grammar?: CopyGrammar } = {},
): ShellCopy<T> {
  return deepFreeze({
    kind: 'shell-copy',
    zh: copy.zh,
    en: copy.en,
    samples: options.samples ?? {},
    grammar: options.grammar ?? {},
  });
}

export function isShellCopy(value: unknown): value is ShellCopy<CopyTree> {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'shell-copy';
}

export function resolveShellCopy<T extends CopyTree>(copy: ShellCopy<T>, language: ShellLanguage): T {
  return copy[language];
}

/** The words of one surface in the language the user chose. Flipping the language re-renders readers; nothing remounts. */
export function useShellCopy<T extends CopyTree>(copy: ShellCopy<T>): T {
  return resolveShellCopy(copy, useShellLanguage());
}
