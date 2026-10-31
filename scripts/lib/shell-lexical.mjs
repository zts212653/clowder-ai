/** Shared shell boundary facts. No effects, targets, or permission decisions live here. */
export function scanShellText(source) {
  const raw = String(source ?? '');
  const view = scanContext(raw, 0, raw.length, false, 0);
  let text = '',
    cursor = 0;
  for (const { start, end } of view.comments.sort((a, b) => a.start - b.start)) {
    text += raw.slice(cursor, start) + ' '.repeat(end - start);
    cursor = end;
  }
  return { ...view, text: text + raw.slice(cursor) };
}

function scanContext(raw, start, limit, substitution, depth) {
  return new ShellBoundaryScanner(raw, start, limit, substitution, depth).scan();
}

class ShellBoundaryScanner {
  constructor(raw, start, limit, substitution, depth) {
    this.raw = raw;
    this.index = start;
    this.limit = limit;
    this.substitution = substitution;
    this.depth = depth;
    this.wordStart = true;
    this.groups = 0;
    this.view = {
      end: limit,
      complete: depth <= 16,
      comments: [],
      substitutions: [],
      parameters: [],
      boundaries: [],
      continuations: [],
    };
  }

  scan() {
    if (!this.view.complete) return this.view;
    while (this.index < this.limit && !this.closed) this.step();
    if (!this.closed) this.view.complete &&= !this.quote && this.groups === 0 && !this.substitution;
    return this.view;
  }

  step() {
    const char = this.raw[this.index];
    if (this.quote === "'") return this.singleQuoted(char);
    if (char === '\\') return this.escape();
    if (!this.quote && char === '#' && this.wordStart) return this.comment();
    const parenthesized =
      this.raw.startsWith('$(', this.index) || (!this.quote && /[<>]/.test(char) && this.raw[this.index + 1] === '(');
    if (parenthesized || char === '`') return this.nested(parenthesized);
    if (char === '$' && this.parameter()) return;
    if (char === '"' || (!this.quote && char === "'")) return this.quoted(char);
    if (this.quote) this.index += 1;
    else this.syntax(char);
  }

  singleQuoted(char) {
    if (char === "'") this.quote = undefined;
    this.index += 1;
  }

  quoted(char) {
    this.quote = this.quote === char ? undefined : char;
    this.wordStart = false;
    this.index += 1;
  }

  escape() {
    if (this.index + 1 >= this.limit) this.view.complete = false;
    if (this.raw[this.index + 1] === '\n') this.view.continuations.push({ start: this.index, end: this.index + 2 });
    else this.wordStart = false;
    this.index += 2;
  }

  comment() {
    const newline = this.raw.indexOf('\n', this.index);
    const end = newline < 0 ? this.limit : Math.min(this.limit, newline);
    this.view.comments.push({ start: this.index, end });
    this.index = end;
  }

  nested(parenthesized) {
    const bodyStart = this.index + (parenthesized ? 2 : 1);
    const close = parenthesized ? this.limit : backtickEnd(this.raw, bodyStart, this.limit);
    const body = parenthesized ? null : decodeBacktickBody(this.raw.slice(bodyStart, close < 0 ? this.limit : close));
    const child = parenthesized
      ? scanContext(this.raw, bodyStart, this.limit, true, this.depth + 1)
      : scanContext(body, 0, body.length, false, this.depth + 1);
    const end = parenthesized ? child.end : close;
    const closed = end >= 0 && end < this.limit;
    this.view.complete &&= child.complete && closed;
    if (!parenthesized && child.comments.some(({ start, end }) => /\\/.test(body.slice(start, end))))
      this.view.complete = false;
    // Bash 3.2 bracket-scans substitutions inside double quotes differently from
    // modern shells when their comments contain quote/escape syntax. No dialect
    // certificate is present in hook argv, so this ambiguous form stays incomplete.
    if (
      parenthesized &&
      this.quote === '"' &&
      child.comments.some(({ start, end }) => /['"`\\]/.test(this.raw.slice(start, end)))
    )
      this.view.complete = false;
    // Arithmetic and case patterns need grammar beyond these lexical facts.
    if (this.raw.startsWith('$((', this.index)) this.view.complete = false;
    if (parenthesized) {
      this.view.comments.push(...child.comments);
      this.view.continuations.push(...child.continuations);
    }
    this.view.substitutions.push({
      start: this.index,
      end: closed ? end + 1 : this.limit,
      bodyStart,
      bodyEnd: closed ? end : this.limit,
      kind: parenthesized ? 'parenthesized' : 'backtick',
    });
    this.index = closed ? end + 1 : this.limit;
    this.wordStart = false;
  }

  parameter() {
    // Only the expansion boundary is projected. Keep the rest of a complex
    // ${...} expression visible so nested executed substitutions are still read.
    const word = this.raw.slice(this.index).match(/^\$(?:\{[A-Za-z_0-9]\w*\}|[A-Za-z_]\w*|[0-9@*?#$!-]|(?=\{))/)?.[0];
    if (!word) return false;
    this.view.parameters.push({ start: this.index, end: this.index + word.length, quote: this.quote });
    this.index += word.length;
    this.wordStart = false;
    return true;
  }

  syntax(char) {
    // Heredoc bodies inside substitutions need delimiter grammar this bounded
    // scanner does not model. Every consumer must see that uncertainty.
    if (this.substitution && this.raw.startsWith('<<', this.index) && !this.raw.startsWith('<<<', this.index))
      this.view.complete = false;
    if (this.wordStart && /^case(?=\s)/.test(this.raw.slice(this.index, this.index + 5))) this.view.complete = false;
    if (char === '(') this.groups += 1;
    if (char === ')') {
      if (this.groups > 0) this.groups -= 1;
      else if (this.substitution) {
        this.view.end = this.index;
        this.closed = true;
        return;
      }
    }
    // Descriptor duplication and redirection operators do not run another stage.
    if (/^(?:[<>]&|>\||&>)/.test(this.raw.slice(this.index, this.index + 2))) {
      this.index += 2;
      this.wordStart = true;
      return;
    }
    const boundary = boundaryAt(this.raw, this.index);
    if (boundary) {
      this.view.boundaries.push({ ...boundary, start: this.index, end: this.index + boundary.width });
      this.index += boundary.width;
      this.wordStart = true;
    } else {
      this.wordStart = /[ \t<>]/.test(char);
      this.index += 1;
    }
  }
}

// Legacy backticks are delimited before their body is interpreted as shell source;
// an inner comment cannot consume the outer closing delimiter or its suffix.
function backtickEnd(raw, start, limit) {
  for (let index = start; index < limit; index += 1) {
    if (raw[index] === '\\') index += 1;
    else if (raw[index] === '`') return index;
  }
  return -1;
}

/** Legacy backticks remove these escapes before their body becomes shell source. */
function decodeBacktickBody(body) {
  return body.replace(/\\([$`\\])/g, '$1');
}

function boundaryAt(raw, index) {
  const char = raw[index],
    pair = raw.slice(index, index + 2);
  if (['&&', '||'].includes(pair)) return { kind: 'execution', width: 2 };
  if (char === ';' || char === '&') return { kind: 'execution', width: 1 };
  if (char === '|') return { kind: 'pipeline', width: pair === '|&' ? 2 : 1 };
  if (char === '\n' || char === '\r') return { kind: 'line', width: pair === '\r\n' ? 2 : 1 };
  if (char === '(' || char === ')') return { kind: 'group', width: 1 };
  return null;
}

/** Preserve offsets and separator ownership for cwd/binding and heredoc consumers. */
export function shellSegments(raw, { lines = true, execution = true, pipelines = true, groups = false } = {}) {
  const view = scanShellText(raw);
  const segments = [];
  let start = 0,
    separator = null;
  const push = (end, next) => {
    const text = view.text.slice(start, end).trim();
    if (text) segments.push({ text, separator, start, end });
    separator = !text && ['&&', '||'].includes(separator) ? separator : next;
  };
  for (const boundary of view.boundaries) {
    if (!{ line: lines, execution, pipeline: pipelines, group: groups }[boundary.kind]) continue;
    push(boundary.start, boundary.kind === 'line' ? '\n' : view.text.slice(boundary.start, boundary.end));
    start = boundary.end;
  }
  push(view.text.length, null);
  return { segments, complete: view.complete };
}

/** Extract only executed substitutions; comments and single quotes are data. */
export function shellSubstitutions(
  raw,
  placeholder,
  { continuations = false, parameters = false, parameterValue, indexed = false } = {},
) {
  const view = scanShellText(raw);
  let text = '',
    cursor = 0;
  const inner = [];
  const markers = [];
  const replacements = [...view.substitutions, ...(parameters ? view.parameters : [])].sort(
    (a, b) => a.start - b.start,
  );
  for (const span of replacements) {
    const value = !span.kind ? parameterValue?.(raw.slice(span.start, span.end), span.quote) : undefined;
    const marker = indexed ? `${placeholder}:${markers.length}\0` : placeholder;
    if (indexed && value === undefined) markers.push({ marker, source: view.text.slice(span.start, span.end) });
    text += projectSlice(view, cursor, span.start, continuations) + (value ?? marker);
    if (span.kind) {
      const body = projectSlice(view, span.bodyStart, span.bodyEnd, continuations);
      inner.push(span.kind === 'backtick' ? decodeBacktickBody(body) : body);
    }
    cursor = span.end;
  }
  return {
    text: text + projectSlice(view, cursor, view.text.length, continuations),
    inner,
    readable: view.complete,
    ...(indexed ? { markers } : {}),
  };
}

/** Derive normalized text from the same facts without discarding their completeness. */
function projectSlice(view, start, end, continuations) {
  if (!continuations) return view.text.slice(start, end);
  let text = '',
    cursor = start;
  for (const span of view.continuations) {
    if (span.start < start || span.end > end) continue;
    text += view.text.slice(cursor, span.start);
    cursor = span.end;
  }
  return text + view.text.slice(cursor, end);
}
