import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type CopyLeaf, type CopyTree, isShellCopy, type ShellCopy } from '../shell-copy';

/**
 * The consistency check behind F322 AC-B8, over a `defineShellCopy` namespace. It returns the problems it found (empty =
 * consistent) so the tests can show both what passes and what each rule catches.
 *
 * What the compiler does and does not do at the `defineShellCopy` call: with an inline `en: { … }` it rejects a missing key, an
 * extra key, text where zh has a template, and parameter types that do not fit. It does NOT enforce exact sameness when `en`
 * is an object declared elsewhere (an extra key passes) or when a parameter type is merely wider. This check is the backstop
 * for keys, and the only one for the rest: text left untranslated in English (including what a template itself prints),
 * placeholders that never got filled, templates nobody called, and a template in one language that ignores a value the other
 * uses. That last one is found by behaviour, not by `.length` (which a default or rest parameter makes meaningless): for each
 * argument — or each field of an object argument — the samples are mixed so that only that one value changes, and if the
 * Chinese text changes the English text must change too. (Not the other way round: English has grammatical number and gender
 * the Chinese lacks, so an English text that varies alone is a correct translation, not a dropped value.)
 *
 * Scope of that rule. It treats every argument as content both languages must use, because from the two texts alone a dropped
 * name and a pronoun that English words differently look the same (zh 她 / 他 against "They are online"). So a template can
 * declare, in `grammar`, the arguments that only pick wording; the English may ignore those. The declaration is the author's
 * statement, read by a reviewer in the diff — this check cannot prove it true. It refuses a malformed one (an argument no
 * sample has, something that is not a template) and one the Chinese contradicts by printing the value, since a printed value
 * is content. It does not decide whether a non-printed value (a flag that adds 紧急) is wording or content: that is the author's
 * call, and an undeclared one is checked as content.
 */

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/u;
// `{count}`, `${`, `%s`/`%d`, and what a template prints when it was handed the wrong thing.
const LEFTOVER = /\{[A-Za-z_]\w*\}|\$\{|%[sd]|\bundefined\b|\bNaN\b|\[object /;

type Node = CopyLeaf | CopyTree;
type Language = 'zh' | 'en';

function isTree(node: Node | undefined): node is CopyTree {
  return typeof node === 'object' && node !== null;
}

function describeNode(node: Node | undefined): string {
  if (node === undefined) return 'missing';
  if (typeof node === 'string') return 'text';
  if (typeof node === 'function') return 'template';
  return 'group';
}

function kindOf(node: Node | undefined): string {
  return isTree(node) ? 'group' : typeof node;
}

function checkText(path: string, language: Language, text: string, problems: string[]): void {
  if (text.trim() === '') problems.push(`${path}: ${language} is empty`);
  else if (LEFTOVER.test(text)) {
    problems.push(`${path}: ${language} has an unfilled placeholder: ${JSON.stringify(text)}`);
  }
  if (language === 'en' && CJK.test(text)) problems.push(`${path}: en still has Chinese: ${JSON.stringify(text)}`);
}

function walkGroup(zh: CopyTree, en: CopyTree, path: string, problems: string[], templates: string[]): void {
  for (const key of new Set([...Object.keys(zh), ...Object.keys(en)])) {
    const child = path ? `${path}.${key}` : key;
    // `samples` addresses a template by its dotted path, so a key that holds a dot could not be told from a nested one.
    if (key.includes('.')) problems.push(`${child}: key contains a dot — samples address templates by dotted path`);
    walk(zh[key], en[key], child, problems, templates);
  }
}

function compareLeaves(zh: Node, en: Node, path: string, problems: string[], templates: string[]): void {
  if (typeof zh === 'function' && typeof en === 'function') {
    templates.push(path);
    return;
  }
  if (typeof zh === 'string') checkText(path, 'zh', zh, problems);
  if (typeof en === 'string') checkText(path, 'en', en, problems);
}

/** Compares the two trees leaf by leaf; the dotted path of every template found goes into `templates`. */
function walk(zh: Node | undefined, en: Node | undefined, path: string, problems: string[], templates: string[]): void {
  if (isTree(zh) && isTree(en)) {
    walkGroup(zh, en, path, problems, templates);
  } else if (zh === undefined || en === undefined || kindOf(zh) !== kindOf(en)) {
    problems.push(`${path}: zh is ${describeNode(zh)} but en is ${describeNode(en)}`);
  } else {
    compareLeaves(zh, en, path, problems, templates);
  }
}

function at(tree: CopyTree, path: string): Node | undefined {
  let node: Node | undefined = tree;
  for (const key of path.split('.')) node = isTree(node) ? node[key] : undefined;
  return node;
}

type Template = (...args: unknown[]) => unknown;
type Args = readonly unknown[];
type Outcome = { readonly out: unknown } | { readonly error: string };

function run(template: Template, args: Args): Outcome {
  try {
    return { out: template(...args) };
  } catch (error) {
    return { error: String(error) };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Every string handed in as an argument, however deep: a name typed by a person may be Chinese inside an English sentence. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return isPlainObject(value) ? Object.values(value).flatMap(stringsIn) : [];
}

/** What the template itself printed: the output with the arguments it was given taken back out. */
function ownWords(out: string, args: Args): string {
  return stringsIn(args).reduce((rest, handedIn) => rest.split(handedIn).join(''), out);
}

function callTemplate(copy: ShellCopy<CopyTree>, language: Language, path: string, problems: string[]): void {
  const template = at(copy[language], path) as Template | undefined;
  if (typeof template !== 'function') return;
  for (const args of copy.samples[path] ?? []) {
    const shown = JSON.stringify(args);
    const result = run(template, args);
    if ('error' in result) problems.push(`${path}: ${language}(${shown}) threw: ${result.error}`);
    else if (typeof result.out !== 'string' || result.out.trim() === '' || LEFTOVER.test(result.out)) {
      problems.push(`${path}: ${language}(${shown}) printed ${JSON.stringify(result.out)}`);
    } else if (language === 'en' && CJK.test(ownWords(result.out, args))) {
      problems.push(`${path}: en(${shown}) printed Chinese: ${JSON.stringify(result.out)}`);
    }
  }
}

/** One value a template can be given: a positional argument, or one field of an object argument. */
interface Slot {
  readonly position: number;
  readonly field?: string;
  readonly label: string;
}

function slotsOf(samples: ReadonlyArray<Args>): Slot[] {
  const slots = new Map<string, Slot>();
  for (const args of samples) {
    args.forEach((value, position) => {
      const fields = isPlainObject(value) ? Object.keys(value) : [undefined];
      for (const field of fields) {
        const label = field === undefined ? `${position}` : `${position}.${field}`;
        slots.set(label, { position, field, label });
      }
    });
  }
  return [...slots.values()];
}

function valueAt(args: Args, slot: Slot): unknown {
  const value = args[slot.position];
  if (slot.field === undefined) return value;
  return isPlainObject(value) ? value[slot.field] : undefined;
}

function withValue(args: Args, slot: Slot, value: unknown): Args {
  const next = [...args];
  const current = args[slot.position];
  next[slot.position] =
    slot.field === undefined ? value : { ...(isPlainObject(current) ? current : {}), [slot.field]: value };
  return next;
}

function printed(template: Template, args: Args): string | undefined {
  const result = run(template, args);
  return 'out' in result && typeof result.out === 'string' ? result.out : undefined;
}

/**
 * Does changing only this one value change the Chinese text but not the English? That is the English dropping a value the
 * Chinese uses. The other direction is allowed on purpose: English has grammatical number the Chinese lacks ("Member online" /
 * "Members online" against one unchanged Chinese label), so an English text that varies where the Chinese does not cannot be
 * told from a dropped Chinese value, and rejecting it would reject correct translations.
 */
function englishIgnoresWhatChineseUses(zh: Template, en: Template, base: Args, mixed: Args): boolean {
  const zhBefore = printed(zh, base);
  const zhAfter = printed(zh, mixed);
  const enBefore = printed(en, base);
  const enAfter = printed(en, mixed);
  if ([zhBefore, zhAfter, enBefore, enAfter].includes(undefined)) return false; // a throw is already reported
  return zhBefore !== zhAfter && enBefore === enAfter;
}

/** How a value would show up in text, when it can: a non-empty string or a finite number. Anything else is never printed verbatim. */
function shownForm(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

/**
 * Does this template print the value itself? Yes when its text contains the value and stops containing it once the value is
 * swapped for another sample's — so fixed Chinese text that merely holds the same digit or word is not mistaken for it.
 */
function printsItself(template: Template, samples: ReadonlyArray<Args>, slot: Slot): boolean {
  return samples.some((base) => {
    const shown = shownForm(valueAt(base, slot));
    if (shown === undefined || !printed(template, base)?.includes(shown)) return false;
    return samples.some((other) => {
      const swapped = valueAt(other, slot);
      if (isDeepStrictEqual(swapped, valueAt(base, slot))) return false;
      const text = printed(template, withValue(base, slot, swapped));
      return text !== undefined && !text.includes(shown);
    });
  });
}

/** One argument, judged on its own: seen to vary, then either a declared choice of wording or content both languages must use. */
function checkSlot(
  path: string,
  { zh, en }: { readonly zh: Template; readonly en: Template },
  samples: ReadonlyArray<Args>,
  slot: Slot,
  declaredGrammar: boolean,
  problems: string[],
): void {
  const values = samples.map((args) => valueAt(args, slot));
  if (!values.some((value) => !isDeepStrictEqual(value, values[0]))) {
    problems.push(
      `${path}: argument ${slot.label} takes the same value in every sample — add a sample that differs, or a dropped value cannot be seen`,
    );
    return;
  }
  if (declaredGrammar) {
    if (printsItself(zh, samples, slot)) {
      problems.push(
        `${path}: argument ${slot.label} is declared a grammatical choice, but the Chinese prints the value itself — that makes it content: take it out of grammar and have the English use it`,
      );
    }
    return;
  }
  const ignored = samples.some((base) =>
    samples.some((other) => englishIgnoresWhatChineseUses(zh, en, base, withValue(base, slot, valueAt(other, slot)))),
  );
  if (ignored) {
    problems.push(
      `${path}: argument ${slot.label} changes the Chinese text but not the English — the English ignores a value the Chinese uses (if the value only picks wording, such as a gender, and is not itself shown, declare it: grammar: { '${path}': ['${slot.label}'] })`,
    );
  }
}

function checkArgumentUse(copy: ShellCopy<CopyTree>, path: string, problems: string[]): void {
  const zh = at(copy.zh, path);
  const en = at(copy.en, path);
  const samples = copy.samples[path] ?? [];
  if (typeof zh !== 'function' || typeof en !== 'function') return;
  const templates = { zh: zh as Template, en: en as Template };
  const slots = slotsOf(samples);
  const grammatical = new Set<string>(copy.grammar[path] ?? []);
  for (const label of grammatical) {
    if (!slots.some((slot) => slot.label === label)) {
      problems.push(`${path}: grammar names argument ${label}, which no sample has`);
    }
  }
  for (const slot of slots) checkSlot(path, templates, samples, slot, grammatical.has(slot.label), problems);
}

function checkTemplates(copy: ShellCopy<CopyTree>, templates: string[], problems: string[]): void {
  for (const path of templates) {
    if (!copy.samples[path]?.length) {
      problems.push(`${path}: template with no samples — list the argument lists the test should call it with`);
      continue;
    }
    callTemplate(copy, 'zh', path, problems);
    callTemplate(copy, 'en', path, problems);
    checkArgumentUse(copy, path, problems);
  }
  for (const path of Object.keys(copy.samples)) {
    if (!templates.includes(path)) problems.push(`${path}: samples for something that is not a template`);
  }
  for (const path of Object.keys(copy.grammar)) {
    if (!templates.includes(path)) problems.push(`${path}: grammar for something that is not a template`);
  }
}

export function checkShellCopyParity(copy: ShellCopy<CopyTree>): string[] {
  const problems: string[] = [];
  const templates: string[] = [];
  walk(copy.zh, copy.en, '', problems, templates);
  checkTemplates(copy, templates, problems);
  return problems;
}

/**
 * The dictionary is the files named `*.shell-copy.ts` under a root (each beside the surface it words): list them, no registry
 * to edit. Test folders are skipped unless asked for, so a fixture never counts as a real surface.
 */
export function listShellCopyFiles(root: string, options: { readonly includeTests?: boolean } = {}): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.name === '__tests__' && !options.includeTests) continue;
      found.push(...listShellCopyFiles(path, options));
    } else if (entry.name.endsWith('.shell-copy.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

export async function loadShellCopies(file: string): Promise<Array<{ name: string; copy: ShellCopy<CopyTree> }>> {
  const loaded: Record<string, unknown> = await import(/* @vite-ignore */ file);
  return Object.entries(loaded)
    .filter(([, value]) => isShellCopy(value))
    .map(([name, value]) => ({ name, copy: value as ShellCopy<CopyTree> }));
}
