import { findExecutedCommands } from '../native-effect-find-classifier.mjs';
import { commandName, shellInvocation, shellWords } from '../native-effect-shell-tokenizer.mjs';
import { packageManagerInvocation } from './package-manager-invocation.mjs';
import {
  argumentEvidence,
  attachArgumentEvidence,
  codeParameters,
  forkParameterFrame,
  inlineCode,
  inputCode,
  launcherInputs,
  literalOutput,
  mergedPipelineOutput,
  opaqueCodeEvidence,
  operandSources,
  optionValue,
  parameterEvidence,
  parameterFrame,
  parameterValue,
  pipelineOutput,
  SHELLS,
  scriptFileCall,
  setParameters,
  shellCall,
} from './shell-code-inputs.mjs';
import { scanShellText } from './shell-lexical.mjs';
import { annotateCoordinate, moveCoordinate, programTokens, unreadableProgram } from './shell-program-tokens.mjs';
import { extractSubstitutions, SUBSTITUTION, splitCommandLines, splitPipelineStages, unquote } from './shell-text.mjs';
import { afterWrapper, XARGS_WRAPPER } from './shell-wrappers.mjs';
/** F300/F306 reader: program, argv, code input and completeness stay separate. */
export { optionValue, splitCommandLines, unquote };
const MAX_RECURSION = 8;
export function executedInvocations(
  raw,
  { depth = 0, cwd, parameters = parameterFrame(), bindings, stdin: input } = {},
) {
  if (depth > MAX_RECURSION) return { pipelines: [], complete: false };
  const pipelines = [];
  const directInvocations = [];
  const outputs = [];
  const unresolvedEvidence = [];
  const lexical = scanShellText(raw);
  let complete = lexical.complete;
  const frame = forkParameterFrame(parameters);
  const lines = splitCommandLines(lexical.text, { groups: true });
  const uncertain =
    !lexical.complete ||
    lexical.boundaries.some((b) => b.kind === 'group' || ['&&', '||'].includes(raw.slice(b.start, b.end))) ||
    lines.some((line) => /^(?:if|then|else|elif|for|while|until|case|function)\b/.test(line));
  for (const line of lines) {
    const pipeline = [];
    const stages = splitPipelineStages(line);
    let stdin = input;
    for (const stage of stages) {
      const parsed = parseStage(stage, depth, cwd, stdin, frame, bindings);
      if (!parsed.complete) complete = false;
      // Keep every stage: dropping one would hand its successor the wrong stdin.
      if (parsed.invocation) {
        pipeline.push(parsed.invocation);
        directInvocations.push(parsed.invocation);
      }
      pipelines.push(...parsed.nested);
      unresolvedEvidence.push(...(parsed.unresolvedEvidence ?? []));
      if (!parsed.invocation && !parsed.complete) unresolvedEvidence.push(stage);
      if (parsed.invocation || !parsed.complete) stdin = pipelineOutput(parsed.output, stdin, stage);
      if (stages.length === 1 && parsed.invocation?.name === 'set' && parsed.invocation.operands[0] === '--') {
        const values = parsed.invocation.operands.slice(1);
        const sources = operandSources(values, parsed.markers, bindings, frame);
        setParameters(frame, values, sources, uncertain);
      }
    }
    if (pipeline.length > 0) pipelines.push(pipeline);
    if (stdin) outputs.push(stdin);
  }
  const output = mergedPipelineOutput(outputs);
  return {
    pipelines,
    complete,
    directInvocations,
    unresolvedEvidence,
    parameterScope: depth,
    parameters: frame,
    output,
  };
}
export function executionChainInvocations(raw, { cwd, bindings, stdin: input } = {}) {
  const combined = { pipelines: [], complete: true, unresolvedEvidence: [] };
  let stdin = input;
  for (const unit of splitPipelineStages(raw)) {
    const reader = executedInvocations(unit, { cwd, bindings, stdin });
    combined.pipelines.push(...reader.pipelines);
    combined.unresolvedEvidence.push(...reader.unresolvedEvidence);
    combined.complete &&= reader.complete;
    stdin = reader.output;
  }
  return { ...combined, output: stdin };
}
function nestedFrom(source, depth, cwd, parameters = parameterFrame(), bindings) {
  const result = executedInvocations(source, { depth: depth + 1, cwd, parameters, bindings });
  attachArgumentEvidence(result, parameters);
  return {
    nested: result.pipelines,
    complete: result.complete,
    unresolvedEvidence: result.unresolvedEvidence,
    parameterScope: result.parameterScope,
  };
}
/** Read a code input without dropping its producer's pipeline slot. */
function inlineExecution({
  script,
  name,
  stage,
  depth,
  cwd,
  nested,
  complete,
  parameters = parameterFrame(),
  bindings,
  sourceScope = depth,
  codeEvidence,
}) {
  const stageInvocation = shellCall(name, [], stage, cwd);
  stageInvocation.script = script;
  stageInvocation.codeEvidence = codeEvidence;
  stageInvocation.parameterScope = sourceScope;
  if (script?.includes(SUBSTITUTION)) {
    // A generated code operand is re-parsed; its literal prefix proves nothing.
    stageInvocation.generatedCode = true;
    return { invocation: stageInvocation, nested, complete: false };
  }
  if (!script) {
    return { invocation: stageInvocation, nested, complete: false };
  }
  const result = nestedFrom(script, depth, cwd, parameters, bindings);
  for (const call of result.nested.flat())
    if (call.parameterScope === result.parameterScope && (call.generatedCode || call.name === undefined))
      call.codeEvidence = [...(call.codeEvidence ?? []), ...(codeEvidence ?? [])];
  stageInvocation.delegated = true;
  return {
    invocation: stageInvocation,
    nested: [...nested, ...result.nested],
    complete: complete && result.complete,
    unresolvedEvidence: result.unresolvedEvidence,
  };
}
function parseStage(stage, depth, outerCwd, stdin, frame, bindings) {
  const substitutions = extractSubstitutions(stage, {
    continuations: true,
    parameters: true,
    indexed: true,
    parameterValue: (word, quote) => parameterValue(word, quote, frame, bindings),
  });
  const nested = [];
  let complete = substitutions.readable;
  for (const inner of substitutions.inner) {
    const result = nestedFrom(inner, depth, outerCwd, frame, bindings);
    nested.push(...result.nested);
    if (!result.complete) complete = false;
  }
  const unreadable = { invocation: undefined, nested, complete: false };

  const parsed = shellInvocation(substitutions.text);
  if (parsed.redirections.some((item) => /^(?:\d*)<<-?$/.test(item.operator))) complete = false;
  let tokens = parsed.syntaxComplete ? parsed.words.map(({ value }) => value) : null;
  if (!tokens) {
    // Bash may execute complete words before a dangling EOF escape/quote.
    tokens = shellWords(substitutions.text, { prefixOnly: true, operatorsAreData: true })?.map(({ value }) => value);
    complete = false;
  }
  if (!tokens || tokens.length === 0) return unreadable;
  const program = programTokens(tokens, outerCwd);
  const result = parseArgv(program, stage, depth, nested, complete, {
    stdin,
    frame,
    sourceScope: depth,
    bindings,
    markers: substitutions.markers,
    redirections: parsed.redirections,
  });
  if (result.invocation) {
    if (result.invocation.name === undefined) {
      result.invocation.generatedCode = true;
      result.invocation.codeEvidence = parameterEvidence(stage, undefined, frame);
    }
    const linked = parameterEvidence(stage, bindings, frame);
    result.invocation.parameterScope = depth;
    const operandEvidence =
      result.invocation.argumentEvidence ??
      argumentEvidence(result.invocation.operands, substitutions.markers, bindings, frame);
    result.invocation.argumentEvidence = [...new Set([...operandEvidence, ...linked])];
    result.invocation.inputEvidence = stdin?.evidence ?? [];
    result.invocation.redirections = parsed.redirections;
    result.output = literalOutput(result.invocation.name, result.invocation.operands, stage);
    result.output.evidence.push(...linked);
  } else if (!result.complete) {
    result.unresolvedEvidence = [...(result.unresolvedEvidence ?? []), ...parameterEvidence(stage, bindings, frame)];
  }
  result.markers = substitutions.markers;
  return annotateCoordinate(result, program, parsed.complete && substitutions.inner.length === 0);
}
function parseArgv(program, stage, depth, nested = [], complete = true, inputs = {}) {
  if (depth > MAX_RECURSION) return { invocation: undefined, nested, complete: false };
  const unreadable = { invocation: undefined, nested, complete: false };

  if (program.script !== undefined)
    return inlineExecution({
      script: program.script,
      name: commandName(program.rest[0]),
      stage,
      depth,
      cwd: program.cwd,
      nested,
      complete: complete && program.complete,
      parameters: inputs.frame,
      bindings: inputs.bindings,
      sourceScope: inputs.sourceScope,
      codeEvidence: operandSources([program.script], inputs.markers, inputs.bindings, inputs.frame).flat(),
    });
  if (!program.complete) return unreadable;
  const cwd = program.cwd;
  const rest = program.rest;
  if (rest.length === 0) return { invocation: undefined, nested, complete };
  if (unreadableProgram(rest[0])) {
    const call = shellCall(undefined, rest.slice(1), stage, cwd);
    call.generatedCode = true;
    call.parameterScope = inputs.sourceScope ?? depth;
    call.codeEvidence = operandSources([rest[0]], inputs.markers, inputs.bindings, inputs.frame).flat();
    return { invocation: call, nested, complete: false };
  }

  const name = commandName(rest[0]);
  const operands = rest.slice(1);

  if (name === 'pnpm' || name === 'npm') {
    const command = packageManagerInvocation(name, operands);
    const childCwd = command.cwdUnknown
      ? undefined
      : command.cwd === undefined
        ? cwd
        : moveCoordinate(command.cwd, cwd);
    const coordinateComplete = command.cwd === undefined || childCwd !== undefined;
    if (command.kind === 'shell')
      return inlineExecution({
        script: command.source,
        name,
        stage,
        depth,
        cwd: childCwd,
        nested,
        complete: complete && command.complete && coordinateComplete,
        sourceScope: inputs.sourceScope,
        codeEvidence: operandSources([command.source], inputs.markers, inputs.bindings, inputs.frame).flat(),
      });
    if (command.kind === 'argv') {
      const childProgram = programTokens(command.argv, childCwd);
      const child = parseArgv(childProgram, stage, depth + 1, [], true, {
        ...inputs,
        sourceScope: inputs.sourceScope ?? depth,
      });
      if (child.invocation) {
        child.invocation.parameterScope = inputs.sourceScope ?? depth;
        nested.push([child.invocation]);
      }
      nested.push(...child.nested);
      complete = complete && command.complete && coordinateComplete && child.complete;
      inputs.delegated = true;
    } else complete = complete && command.complete;
  }

  const inline = inlineCode(name, operands);
  if (inline !== undefined) {
    return inlineExecution({
      script: inline.script,
      name,
      stage,
      depth,
      cwd,
      nested,
      complete,
      parameters: codeParameters(inline, inputs),
      bindings: SHELLS.has(name) ? undefined : inputs.bindings,
      sourceScope: inputs.sourceScope,
      codeEvidence: operandSources([inline.script], inputs.markers, inputs.bindings, inputs.frame).flat(),
    });
  }

  const input = inputCode(
    name,
    operands,
    inputs.redirections ?? [],
    inputs.stdin,
    stage,
    inputs.bindings,
    inputs.frame,
  );
  if (input)
    return inlineExecution({
      script: input.generated ? SUBSTITUTION : input.source,
      name,
      stage,
      depth,
      cwd,
      nested,
      complete,
      parameters: inputs.frame,
      sourceScope: inputs.sourceScope,
      bindings: ['source', '.'].includes(name) ? inputs.bindings : undefined,
      codeEvidence: [...input.evidence, ...parameterEvidence(input.source ?? '', inputs.bindings, inputs.frame)],
    });

  if (SHELLS.has(name ?? '') || ['source', '.'].includes(name))
    return { invocation: scriptFileCall(operands, stage, cwd), nested, complete };

  if (name === 'find' || name === 'xargs') {
    const consumed = name === 'xargs' ? afterWrapper(XARGS_WRAPPER, operands) : undefined;
    const childInputs = launcherInputs(name, consumed, inputs, stage);
    const children =
      name === 'find'
        ? findExecutedCommands(operands)
        : [{ args: childInputs.args, complete: consumed.complete, localCwd: true }];
    for (const child of children) {
      const childProgram = programTokens(child.args, child.localCwd ? cwd : undefined);
      const parsed = parseArgv(childProgram, stage, depth + 1, [], true, {
        ...childInputs,
        stdin:
          child.stdinUnknown && childInputs.stdin
            ? { generated: true, evidence: childInputs.stdin.evidence }
            : childInputs.stdin,
        sourceScope: inputs.sourceScope ?? depth,
      });
      if (parsed.invocation) {
        if (name === 'xargs') parsed.invocation.inputOwner = 'xargs';
        nested.push([parsed.invocation]);
      }
      nested.push(...parsed.nested);
      complete = complete && child.complete && parsed.complete;
    }
    inputs.delegated = complete;
  }

  if (name === 'node') {
    // `node -e '<js>'` executes code this module does not model.
    const inline = operands.some((token) => ['-e', '--eval', '-p', '--print'].includes(token));
    const invocation = inline ? shellCall(name, operands, stage, cwd) : scriptFileCall(operands, stage, cwd);
    if (invocation) {
      invocation.interpreter = name;
      return { invocation, nested, complete };
    }
  }

  const result = shellCall(name, operands, stage, cwd);
  result.argumentEvidence = argumentEvidence(operands, inputs.markers, inputs.bindings, inputs.frame);
  result.unprovedCodeEvidence = opaqueCodeEvidence(name, operands, inputs);
  result.inputEvidence = inputs.stdin?.evidence ?? [];
  result.delegated = inputs.delegated || name === 'set';
  return { invocation: result, nested, complete };
}
