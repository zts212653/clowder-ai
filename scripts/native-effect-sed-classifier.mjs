/** Effects of a literal sed program. No evaluation or script-file reads occur here. */
export function sedScriptEffect(script) {
  return sedScriptAnalysis(script).effect;
}

/** File paths are complete only after the whole script has been understood. */
export function sedScriptAnalysis(script) {
  let index = 0;
  let depth = 0;
  const paths = [];
  const writes = [];
  while (index < script.length) {
    index = skipSeparators(script, index);
    if (index >= script.length) break;
    const parsed = sedStatement(script, index);
    if (parsed.effect === 'unknown') return incompleteScript(writes);
    depth += parsed.depthChange;
    if (depth < 0 || parsed.next <= index) return { effect: 'unknown', paths: null };
    if (parsed.path !== undefined) paths.push(parsed.path);
    if (parsed.effect === 'write') writes.push(parsed.path);
    index = parsed.next;
  }
  if (depth !== 0) return { effect: 'unknown', paths: null };
  return { effect: writes.length ? 'write' : 'read', paths, writes };
}

function incompleteScript(writes) {
  return { effect: writes.length ? 'write' : 'unknown', paths: null };
}

function sedStatement(script, index) {
  index = commandStart(script, index);
  if (index < 0) return { effect: 'unknown' };
  const command = script[index++];
  if (command === '{' || command === '}') {
    return { effect: 'read', next: index, depthChange: command === '{' ? 1 : -1 };
  }
  return { ...sedCommand(script, index, command), depthChange: 0 };
}

function skipSpaces(script, index) {
  while (/[ \t\r]/.test(script[index] ?? '\n')) index += 1;
  return index;
}

function skipSeparators(script, index) {
  while (index < script.length) {
    if (/[\s;]/.test(script[index])) index += 1;
    else if (script[index] === '#') index = lineEnd(script, index);
    else break;
  }
  return index;
}

function lineEnd(script, index) {
  const newline = script.indexOf('\n', index);
  return newline < 0 ? script.length : newline + 1;
}

function delimitedEnd(script, index, delimiter, regexp = false) {
  for (; index < script.length; index += 1) {
    if (script[index] === '\\') index += 1;
    else if (script[index] === delimiter) return index + 1;
    else if (regexp && script[index] === '[') {
      index = bracketEnd(script, index + 1);
      if (index < 0) return -1;
    } else if (script[index] === '\n') return -1;
  }
  return -1;
}

function bracketEnd(script, index) {
  if (script[index] === '^') index += 1;
  if (script[index] === ']') index += 1;
  for (; index < script.length; index += 1) {
    if (script[index] === '\\') index += 1;
    else if (script[index] === ']') return index;
    else if (script[index] === '\n') return -1;
    else index = bracketPieceEnd(script, index);
    if (index < 0) return -1;
  }
  return -1;
}

function bracketPieceEnd(script, index) {
  if (script[index] !== '[' || !/[:.=]/.test(script[index + 1] ?? '')) return index;
  const end = script.indexOf(`${script[index + 1]}]`, index + 2);
  return end < 0 ? -1 : end + 1;
}

function addressEnd(script, index) {
  const numeric = /^(?:\d+(?:~\d+)?|\$)/.exec(script.slice(index));
  if (numeric) return index + numeric[0].length;
  let end = index;
  if (script[index] === '/') end = delimitedEnd(script, index + 1, '/', true);
  else if (script[index] === '\\' && script[index + 1]) end = delimitedEnd(script, index + 2, script[index + 1], true);
  if (end > index) while (/[IM]/.test(script[end] ?? '')) end += 1;
  return end;
}

function commandStart(script, index) {
  const first = addressEnd(script, index);
  if (first < 0) return -1;
  index = skipSpaces(script, first);
  if (script[index] === ',') {
    index = skipSpaces(script, index + 1);
    const relative = /^[+~]\d+/.exec(script.slice(index));
    const second = relative ? index + relative[0].length : addressEnd(script, index);
    if (second <= index) return -1;
    index = skipSpaces(script, second);
  }
  if (script[index] === '!') index = skipSpaces(script, index + 1);
  return index;
}

function commandEnd(script, index) {
  index = skipSpaces(script, index);
  return index === script.length || /[;\n}]/.test(script[index]) ? index : -1;
}

function sedCommand(script, index, command = '\0') {
  if (command === 'w' || command === 'W') return fileCommand(script, index, 'write');
  if (command === 'e') return { effect: 'unknown' };
  if (command === 's' || command === 'y') return replacementEffect(script, index, command === 's');
  if ('pPdDgGhHxznNF='.includes(command)) return { effect: 'read', next: commandEnd(script, index) };
  if ('qQl'.includes(command)) {
    const width = /^[ \t]*\d*/.exec(script.slice(index))[0];
    return { effect: 'read', next: commandEnd(script, index + width.length) };
  }
  if (':btT'.includes(command)) {
    const end = script.slice(index).search(/[;\n}]/);
    return { effect: 'read', next: end < 0 ? script.length : index + end };
  }
  if (command === 'r' || command === 'R') return fileCommand(script, index, 'read');
  if ('aci'.includes(command)) return { effect: 'read', next: textEnd(script, index) };
  return { effect: 'unknown' };
}

function fileCommand(script, index, effect) {
  const next = lineEnd(script, index);
  const end = script[next - 1] === '\n' ? next - 1 : next;
  // These filenames belong to sed's grammar, not shell words. Escapes are not
  // decoded speculatively; an unresolved filename never excludes the cwd.
  const path = script.slice(index, end).replace(/^[ \t]*/, '');
  return { effect, next, path: path && !/[\\\r]/.test(path) ? path : null };
}

function textEnd(script, index) {
  index = skipSpaces(script, index);
  if (script.startsWith('\\\n', index)) index += 2;
  // Text appended to the pattern space is data, including words w/e. Escaped
  // newlines continue that text; the next unescaped newline resumes commands.
  while (index < script.length) {
    if (script[index] === '\\') index += 2;
    else if (script[index++] === '\n') return index;
    else continue;
  }
  return script.length;
}

function replacementEffect(script, index, substitution) {
  const delimiter = script[index++];
  if (!delimiter || /[\\\n]/.test(delimiter)) return { effect: 'unknown' };
  const pattern = delimitedEnd(script, index, delimiter, substitution);
  const replacement = pattern < 0 ? -1 : delimitedEnd(script, pattern, delimiter);
  if (replacement < 0) return { effect: 'unknown' };
  if (!substitution) return { effect: 'read', next: commandEnd(script, replacement) };
  index = replacement;
  while (index < script.length && !/[;\n}]/.test(script[index])) {
    const flag = script[index++];
    if (flag === 'w') return fileCommand(script, index, 'write');
    if (flag === 'e') return { effect: 'unknown' };
    if (!/[ \t\rgpIMim0-9]/.test(flag)) return { effect: 'unknown' };
  }
  return { effect: 'read', next: index };
}
