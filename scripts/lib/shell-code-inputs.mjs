import { BINDING_EVIDENCE } from '../native-effect-shell-expansion.mjs';
import { commandName, tokenizeSimpleShellCommand } from '../native-effect-shell-tokenizer.mjs';
import { scanShellText, shellSubstitutions } from './shell-lexical.mjs';
import { SUBSTITUTION } from './shell-text.mjs';

export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const generated = (value) => value?.includes(SUBSTITUTION);

/** The value of `--opt value` or `--opt=value`, whichever form was used. */
export function optionValue(tokens, option) {
  const index = tokens.indexOf(option);
  if (index >= 0) return tokens[index + 1];
  return tokens.find((token) => token.startsWith(`${option}=`))?.slice(option.length + 1);
}

export function shellCall(name, operands, stage, cwd) {
  return { name, operands, text: stage, cwd, argvEvidence: name ? [name, ...operands].join(' ') : '' };
}

export function scriptFileCall(operands, stage, cwd) {
  const fileIndex = operands.findIndex((token) => !token.startsWith('-'));
  return fileIndex < 0
    ? undefined
    : shellCall(commandName(operands[fileIndex]), operands.slice(fileIndex + 1), stage, cwd);
}

const OPAQUE_CODE_FLAGS = new Map([
  ['python', new Set(['-c'])],
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['perl', new Set(['-e', '-E'])],
  ['ruby', new Set(['-e'])],
  ['osascript', new Set(['-e'])],
]);

/** Provenance entering a foreign interpreter's code operand; literal source stays opaque. */
export function opaqueCodeEvidence(name, operands, inputs) {
  const family = name?.replace(/\d+(?:\.\d+)?$/, '');
  const flags = OPAQUE_CODE_FLAGS.get(family);
  if (!flags) return [];
  const index = operands.findIndex((word) => flags.has(word));
  if (index < 0) return [];
  const evidence = argumentEvidence([operands[index + 1] ?? ''], inputs.markers, inputs.bindings, inputs.frame);
  return evidence.length ? evidence : (inputs.launcherEvidence ?? []);
}

/** A parser-local parameter frame: values and source alternatives never become executor facts. */
export function parameterFrame(values = [], sources = values.map((word) => [word]), zeroSources = []) {
  return { values, vectors: [{ values, sources }], zeroSources };
}
export function forkParameterFrame(frame) {
  return { ...frame, vectors: [...frame.vectors] };
}
export function setParameters(frame, values, sources, uncertain) {
  const vector = { values, sources };
  frame.values = uncertain ? undefined : values;
  frame.vectors = uncertain ? [...frame.vectors, vector] : [vector];
}

/** Only literal values in this frame/path can resolve quoted parameters. */
export function parameterValue(word, quote, frame, bindings) {
  const name = word.slice(1).replace(/^\{(.*)\}$/, '$1');
  const values =
    name === '@'
      ? frame.values
      : /^\d+$/.test(name)
        ? frame.values?.[Number(name) - 1] === undefined
          ? undefined
          : [frame.values[Number(name) - 1]]
        : bindings?.get(name);
  if (quote !== '"' || !values?.length || (name !== '@' && values.length !== 1) || values.some((v) => v.includes('\0')))
    return undefined;
  return values.map((v) => v.replace(/[\\"$`]/g, '\\$&')).join('" "');
}

/** Resolve known positional words without erasing substitutions or named-binding provenance. */
export function expandPositionalParameters(source, frame) {
  let output = '',
    cursor = 0;
  for (const { start, end, quote } of scanShellText(source).parameters) {
    const value = parameterValue(source.slice(start, end), quote, frame);
    if (value === undefined) continue;
    output += source.slice(cursor, start) + value;
    cursor = end;
  }
  return output + source.slice(cursor);
}

/** Select actual parameter slots; alternative writes never concatenate across vectors. */
export function parameterEvidence(stage, bindings, frame) {
  return scanShellText(stage).parameters.flatMap((span) => {
    const name = stage.slice(span.start + 1, span.end).replace(/^\{(.*)\}$/, '$1');
    if (name === '0') return frame?.zeroSources ?? [];
    if (name === '@' || name === '*')
      return (
        frame?.vectors.flatMap(({ values, sources }) => [
          values.join(' '),
          sources.map((items) => items.find((v) => !v.includes('\0')) ?? '').join(' '),
          ...sources.flat(),
        ]) ?? []
      );
    if (/^\d+$/.test(name)) return frame?.vectors.flatMap(({ sources }) => sources[Number(name) - 1] ?? []) ?? [];
    return bindings?.get(BINDING_EVIDENCE + name) ?? bindings?.get(name) ?? [];
  });
}

/** Code operand and shell positional arguments are distinct channels. */
export function inlineCode(name, operands) {
  if (name === 'eval') return { script: operands.join(' '), arguments: undefined };
  if (name === 'trap' && operands[0] && !operands[0].startsWith('-'))
    return { script: operands[0], arguments: undefined };
  if (!SHELLS.has(name ?? '')) return undefined;
  const flagIndex = operands.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
  if (flagIndex < 0) return undefined;
  const scriptIndex = flagIndex + (operands[flagIndex + 1] === '--' ? 2 : 1);
  return {
    script: operands[scriptIndex] ?? '',
    arguments: operands.slice(scriptIndex + 2),
    zero: operands[scriptIndex + 1],
  };
}

/** A deliberately bounded stdout proof: literal echo and printf %s only. No execution. */
export function literalOutput(name, operands, evidence) {
  const unknown = { generated: true, evidence: [evidence] };
  if (operands.some(generated)) return unknown;
  if (name === 'echo' && !operands.some((word) => word.startsWith('-') || word.includes('\\')))
    return { source: `${operands.join(' ')}\n`, evidence: [evidence] };
  if (name !== 'printf' || !operands.length) return unknown;
  const args = operands[0] === '--' ? operands.slice(1) : operands;
  const [format, ...values] = args;
  if (!format || format.startsWith('-')) return unknown;
  if (format === '%s' || format === '%s\n' || format === '%s\\n')
    return { source: values.map((word) => word + (format === '%s' ? '' : '\n')).join(''), evidence: [evidence] };
  if (!/[%\\]/.test(format)) return { source: format, evidence: [evidence] };
  return unknown;
}

/** The reader's existing scanner owns process-substitution boundaries and quotes. */
function processInput(stage, bindings, frame) {
  const view = scanShellText(stage);
  const inputs = view.substitutions.filter((span) => stage.slice(span.start, span.start + 2) === '<(');
  if (inputs.length !== 1 || !view.complete) return { generated: true, evidence: [stage] };
  const span = inputs[0];
  const body = view.text.slice(span.bodyStart, span.bodyEnd);
  const projected = shellSubstitutions(body, SUBSTITUTION, {
    parameters: true,
    parameterValue: (word, quote) => parameterValue(word, quote, frame, bindings),
  });
  const facts = scanShellText(body);
  const evidence = [body, ...parameterEvidence(body, bindings, frame)];
  if (facts.substitutions.length || facts.boundaries.length) return { generated: true, evidence };
  const words = tokenizeSimpleShellCommand(projected.text);
  const output = words?.length ? literalOutput(words[0], words.slice(1), body) : { generated: true, evidence };
  return { ...output, evidence };
}

/** Explicit stdin/file input is code only for the program consuming that channel. */
export function inputCode(name, operands, redirections, stdin, stage, bindings, frame) {
  const source = ['source', '.'].includes(name);
  const stdinFile = ['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0', '-'].includes(operands[0]);
  if (!source && !SHELLS.has(name ?? '')) return undefined;
  if (source && generated(operands[0])) return processInput(stage, bindings, frame);
  const file = operands.find((word) => !word.startsWith('-'));
  if ((source && !stdinFile) || (!source && file && file !== '-')) return undefined;
  const redirect = redirections.find((item) => /^(?:0)?(?:<<<|<<-?|<)$/.test(item.operator));
  if (redirect?.operator.endsWith('<<<')) {
    const value = redirect.operand.value;
    return generated(value) ? { generated: true, evidence: [stage] } : { source: `${value}\n`, evidence: [stage] };
  }
  if (redirect) return { generated: true, evidence: [stage] };
  return stdin;
}

/** An unproved code/program position receives only its own caller's argument evidence. */
export function operandSources(arguments_, markers = [], bindings, frame) {
  return arguments_.map((value) => [value, ...argumentEvidence([value], markers, bindings, frame)]);
}

/** Provenance attached to generated argv positions, excluding their synthetic marker. */
export function argumentEvidence(arguments_, markers = [], bindings, frame) {
  const prefix = `${SUBSTITUTION}:`;
  const byMarker = new Map(
    markers.map(({ marker, source }) => [marker, [source, ...parameterEvidence(source, bindings, frame)]]),
  );
  const evidence = [];
  for (const value of arguments_) {
    let start = value.indexOf(prefix);
    while (start >= 0) {
      const end = value.indexOf('\0', start + prefix.length);
      if (end < 0) break;
      evidence.push(...(byMarker.get(value.slice(start, end + 1)) ?? []));
      start = value.indexOf(prefix, end + 1);
    }
  }
  return [...new Set(evidence)];
}

/** Unknown filters preserve upstream provenance; an exact literal producer replaces it. */
export function pipelineOutput(output, stdin, stage) {
  if (output?.source !== undefined) return output;
  return {
    ...(output ?? {}),
    generated: true,
    evidence: [...new Set([stage, ...(output?.evidence ?? []), ...(stdin?.evidence ?? [])])],
  };
}

/** A grouped pipeline stage emits every contained command's stdout in order. */
export function mergedPipelineOutput(outputs) {
  if (!outputs.length) return undefined;
  const evidence = [...new Set(outputs.flatMap((output) => output.evidence ?? []))];
  return outputs.every((output) => output.source !== undefined)
    ? { source: outputs.map((output) => output.source).join(''), evidence }
    : { generated: true, evidence };
}

/** A shell's new positional scope differs from eval's existing scope. */
export function codeParameters(inline, inputs) {
  if (inline.arguments === undefined) return inputs.frame;
  const sources = (words) => operandSources(words, inputs.markers, inputs.bindings, inputs.frame);
  return parameterFrame(
    inline.arguments,
    sources(inline.arguments),
    inline.zero === undefined ? [] : sources([inline.zero]).flat(),
  );
}

/** xargs owns stdin-to-argv transport; its child's actual template slots own the evidence. */
export function launcherInputs(name, consumed, inputs, stage) {
  if (name !== 'xargs') return { ...inputs, redirections: [] };
  const marker = `${SUBSTITUTION}:stdin\0`;
  const replacement = consumed.replacement;
  const literal = inputs.stdin?.source?.replace(/\n$/, '');
  const args =
    replacement === undefined
      ? [...consumed.rest, literal ?? marker]
      : consumed.rest.map((word) =>
          replacement ? word.replaceAll(replacement, literal ?? marker) : (literal ?? marker),
        );
  const sources = inputs.stdin?.evidence ?? [stage];
  return {
    ...inputs,
    stdin: undefined,
    redirections: [],
    args,
    launcherEvidence: sources,
    markers: [...(inputs.markers ?? []), ...sources.map((source) => ({ marker, source }))],
  };
}

export function attachArgumentEvidence(result, frame) {
  for (const call of result.pipelines.flat()) {
    if (call.parameterScope !== result.parameterScope || (!call.generatedCode && call.name !== undefined)) continue;
    call.codeEvidence = [...(call.codeEvidence ?? []), ...parameterEvidence(call.text, undefined, frame)];
  }
  return result;
}
