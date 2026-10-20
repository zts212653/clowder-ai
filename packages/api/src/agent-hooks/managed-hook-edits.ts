import type { ArraySource, JsonObject, JsonSource, JsonValue, ObjectSource } from './json-source.js';

/**
 * Splices Clowder's own hook entries into the original text. Every byte outside the edited spans
 * stays identical, so third-party values (number lexemes, escapes, key order, formatting) and
 * therefore their native trust hashes are preserved by construction (#1566).
 */

export interface HandlerLocation {
  event: string;
  groupIndex: number;
  handlerIndex: number;
}

export interface ManagedHookEditPlan {
  setCommand: Array<HandlerLocation & { command: string }>;
  remove: HandlerLocation[];
  append: Array<{ event: string; command: string }>;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

interface Layout {
  newline: string;
  unit: string;
}

function detectLayout(text: string): Layout {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indents = [...text.matchAll(/\n([ \t]+)\S/g)].map((match) => match[1]);
  if (indents.some((indent) => indent.startsWith('\t'))) return { newline, unit: '\t' };
  const widths = indents.map((indent) => indent.length);
  return { newline, unit: ' '.repeat(widths.length > 0 ? Math.min(8, ...widths) : 2) };
}

/** Indentation before `offset` when it starts its own line; null for inline containers. */
function lineIndent(text: string, offset: number): string | null {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return lineStart > 0 && /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** Renders one inserted entry; `indent` is null for inline or empty containers (compact JSON). */
type Render = (indent: string | null) => string;

function insertion(
  text: string,
  container: { open: number; firstStart?: number; lastEnd?: number },
  renders: Render[],
  layout: Layout,
): TextEdit {
  if (container.firstStart === undefined || container.lastEnd === undefined) {
    const at = container.open + 1;
    return { start: at, end: at, text: renders.map((render) => render(null)).join(', ') };
  }
  const indent = lineIndent(text, container.firstStart);
  const separator = indent === null ? ', ' : `,${layout.newline}${indent}`;
  return {
    start: container.lastEnd,
    end: container.lastEnd,
    text: renders.map((render) => separator + render(indent)).join(''),
  };
}

function pretty(value: unknown, indent: string, layout: Layout): string {
  return JSON.stringify(value, null, layout.unit).replaceAll('\n', `${layout.newline}${indent}`);
}

function managedGroup(command: string) {
  return { hooks: [{ type: 'command', command }] };
}

function valueRender(value: unknown, layout: Layout): Render {
  return (indent) => (indent === null ? JSON.stringify(value) : pretty(value, indent, layout));
}

function memberRender(key: string, value: unknown, layout: Layout): Render {
  return (indent) => `${JSON.stringify(key)}: ${valueRender(value, layout)(indent)}`;
}

function arrayContainer(source: ArraySource) {
  return { open: source.open, firstStart: source.items[0]?.start, lastEnd: source.items.at(-1)?.end };
}

function objectContainer(source: ObjectSource) {
  const members = [...source.members.values()];
  return { open: source.open, firstStart: members[0]?.keyStart, lastEnd: members.at(-1)?.end };
}

/** Removes array elements together with exactly one adjoining separator each. */
function removalEdits(source: ArraySource, indices: Set<number>): TextEdit[] {
  const { items } = source;
  let tail = items.length;
  while (tail > 0 && indices.has(tail - 1)) tail--;
  const edits = [...indices]
    .filter((index) => index < tail)
    .map((index) => ({ start: items[index].start, end: items[index + 1].start, text: '' }));
  if (tail < items.length) {
    const start = tail === 0 ? items[0].start : items[tail - 1].end;
    edits.push({ start, end: items[items.length - 1].end, text: '' });
  }
  return edits;
}

interface EditContext {
  source: JsonSource;
  root: JsonObject;
  hooks: JsonObject | undefined;
  layout: Layout;
}

const objectSource = (ctx: EditContext, value: JsonObject) => ctx.source.objects.get(value) as ObjectSource;
const arraySource = (ctx: EditContext, value: JsonValue[]) => ctx.source.arrays.get(value) as ArraySource;
const groupsOf = (ctx: EditContext, event: string) => (ctx.hooks as JsonObject)[event] as JsonObject[];

function setCommandEdits(ctx: EditContext, plan: ManagedHookEditPlan['setCommand']): TextEdit[] {
  return plan.map(({ event, groupIndex, handlerIndex, command }) => {
    const handlers = groupsOf(ctx, event)[groupIndex].hooks as JsonObject[];
    const span = objectSource(ctx, handlers[handlerIndex]).members.get('command');
    if (!span) throw new Error('managed handler has no command span');
    return { start: span.start, end: span.end, text: JSON.stringify(command) };
  });
}

/** Removes handlers; a group left without handlers is removed from its event array instead. */
function removeEdits(ctx: EditContext, plan: ManagedHookEditPlan['remove']): TextEdit[] {
  const byGroup = new Map<JsonObject, { event: string; groupIndex: number; handlers: Set<number> }>();
  for (const { event, groupIndex, handlerIndex } of plan) {
    const group = groupsOf(ctx, event)[groupIndex];
    const entry = byGroup.get(group) ?? { event, groupIndex, handlers: new Set<number>() };
    entry.handlers.add(handlerIndex);
    byGroup.set(group, entry);
  }
  const removals = new Map<JsonValue[], Set<number>>();
  const removeFrom = (array: JsonValue[], index: number) =>
    removals.set(array, (removals.get(array) ?? new Set()).add(index));
  for (const [group, { event, groupIndex, handlers }] of byGroup) {
    const groupHandlers = group.hooks as JsonValue[];
    if (handlers.size === groupHandlers.length) removeFrom(groupsOf(ctx, event), groupIndex);
    else for (const index of handlers) removeFrom(groupHandlers, index);
  }
  return [...removals].flatMap(([array, indices]) => removalEdits(arraySource(ctx, array), indices));
}

function appendEdits(ctx: EditContext, plan: ManagedHookEditPlan['append']): TextEdit[] {
  const { source, root, hooks, layout } = ctx;
  if (plan.length === 0) return [];
  if (hooks === undefined) {
    const value = Object.fromEntries(plan.map(({ event, command }) => [event, [managedGroup(command)]]));
    const render = memberRender('hooks', value, layout);
    return [insertion(source.text, objectContainer(objectSource(ctx, root)), [render], layout)];
  }
  const edits: TextEdit[] = [];
  const missing: Render[] = [];
  for (const { event, command } of plan) {
    const existing = hooks[event];
    if (existing === undefined) {
      missing.push(memberRender(event, [managedGroup(command)], layout));
      continue;
    }
    const container = arrayContainer(arraySource(ctx, existing as JsonValue[]));
    edits.push(insertion(source.text, container, [valueRender(managedGroup(command), layout)], layout));
  }
  if (missing.length > 0)
    edits.push(insertion(source.text, objectContainer(objectSource(ctx, hooks)), missing, layout));
  return edits;
}

function splice(text: string, edits: TextEdit[]): string {
  let result = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (edit.end > previousStart) throw new Error('overlapping managed hook edits');
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}

export function applyManagedHookEdits(source: JsonSource, plan: ManagedHookEditPlan): string {
  const root = source.value as JsonObject;
  const ctx: EditContext = {
    source,
    root,
    hooks: root.hooks as JsonObject | undefined,
    layout: detectLayout(source.text),
  };
  return splice(source.text, [
    ...setCommandEdits(ctx, plan.setCommand),
    ...removeEdits(ctx, plan.remove),
    ...appendEdits(ctx, plan.append),
  ]);
}
