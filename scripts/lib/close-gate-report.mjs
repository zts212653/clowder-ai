/**
 * Zero-dependency parser for the CloseGateReport YAML subset used by the
 * follow-up guard. The GitHub workflow runs after checkout without install.
 */

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function indentOf(line) {
  return line.match(/^\s*/)[0].length;
}

function scalarValue(raw) {
  const value = raw.trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function parseInlineList(raw) {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const body = value.slice(1, -1).trim();
  return body ? body.split(',').map((entry) => scalarValue(entry)) : [];
}

function findNestedField(lines, field, parentIndex, endIndex) {
  const parentIndent = indentOf(lines[parentIndex]);
  for (let index = parentIndex + 1; index < endIndex; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= parentIndent) break;
    const match = line.match(new RegExp(`^\\s*${field}:\\s*(.*)$`));
    if (match) return { index, raw: match[1], indent: indentOf(line) };
  }
  return null;
}

function itemEnd(lines, itemIndex, nextItemIndex) {
  const itemIndent = indentOf(lines[itemIndex]);
  for (let index = itemIndex + 1; index < nextItemIndex; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) < itemIndent) return index;
  }
  return nextItemIndex;
}

function findDirectField(lines, field, itemIndex, endIndex) {
  const itemIndent = indentOf(lines[itemIndex]);
  for (let index = itemIndex + 1; index < endIndex; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= itemIndent) break;
    const match = line.match(new RegExp(`^\\s*${field}:\\s*(.*)$`));
    if (match) return { index, raw: match[1], indent: indentOf(line) };
  }
  return null;
}

function parseEvidence(lines, field, endIndex, acId) {
  if (!field) return [];
  const inline = parseInlineList(field.raw);
  if (inline) return inline;
  if (field.raw.trim() !== '') throw new Error(`${acId}: unsupported evidence syntax`);

  const evidence = [];
  for (let index = field.index + 1; index < endIndex; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= field.indent) break;
    if (/^\s*-\s+/.test(line)) evidence.push({ parsed: true });
  }
  return evidence;
}

function parseScope(lines, field, endIndex) {
  if (!field) return undefined;
  const inline = parseInlineList(field.raw);
  if (inline) return inline;
  if (field.raw.trim() !== '') return undefined;

  const scope = [];
  for (let index = field.index + 1; index < endIndex; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= field.indent) break;
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match) scope.push(scalarValue(match[1]));
  }
  return scope;
}

function parseResolution(lines, field, endIndex, acId) {
  if (!field) return undefined;
  const raw = scalarValue(field.raw);
  if (raw === 'null' || raw === '~') return null;
  if (raw !== '') throw new Error(`${acId}: unsupported resolution syntax`);

  const kindField = findNestedField(lines, 'kind', field.index, endIndex);
  const reasonField = findNestedField(lines, 'reason', field.index, endIndex);
  const signoffField = findNestedField(lines, 'cvo_signoff', field.index, endIndex);
  const resolution = {
    kind: kindField ? scalarValue(kindField.raw) : undefined,
    reason: reasonField ? scalarValue(reasonField.raw) : undefined,
  };
  if (!signoffField) return resolution;

  const signoff = {};
  for (const name of ['proposal_message_id', 'cvo_message_id', 'cvo_quote']) {
    const nested = findNestedField(lines, name, signoffField.index, endIndex);
    if (nested) signoff[name] = scalarValue(nested.raw);
  }
  const scopeField = findNestedField(lines, 'accepted_scope', signoffField.index, endIndex);
  signoff.accepted_scope = parseScope(lines, scopeField, endIndex);
  resolution.cvo_signoff = signoff;
  return resolution;
}

export function parseCloseGateReportYaml(candidate) {
  const lines = candidate.split(/\r?\n/);
  const rootIndex = lines.findIndex((line) => /^\s*close_gate_report\s*:\s*$/.test(line));
  if (rootIndex < 0) throw new Error('missing close_gate_report root');

  const rootIndent = indentOf(lines[rootIndex]);
  const matrixIndex = lines.findIndex(
    (line, index) => index > rootIndex && indentOf(line) > rootIndent && /^\s*ac_matrix\s*:/.test(line),
  );
  if (matrixIndex < 0) throw new Error('missing ac_matrix');

  const matrixTail = lines[matrixIndex].match(/^\s*ac_matrix\s*:\s*(.*)$/)?.[1]?.trim() ?? '';
  if (matrixTail === '[]') return { ac_matrix: [] };
  if (matrixTail !== '') throw new Error('ac_matrix must be a YAML block list or []');

  const matrixIndent = indentOf(lines[matrixIndex]);
  const starts = [];
  for (let index = matrixIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) <= matrixIndent) break;
    const match = line.match(/^\s*-\s+ac_id:\s*(.+)$/);
    if (match) starts.push({ index, acId: scalarValue(match[1]) });
  }
  if (starts.length === 0) throw new Error('ac_matrix block has no AC entries');

  const acMatrix = starts.map((item, offset) => {
    const nextItemIndex = starts[offset + 1]?.index ?? lines.length;
    const endIndex = itemEnd(lines, item.index, nextItemIndex);
    const status = findDirectField(lines, 'status', item.index, endIndex);
    const evidence = findDirectField(lines, 'evidence', item.index, endIndex);
    const resolution = findDirectField(lines, 'resolution', item.index, endIndex);
    return {
      ac_id: item.acId,
      status: status ? scalarValue(status.raw) : undefined,
      evidence: parseEvidence(lines, evidence, endIndex, item.acId),
      resolution: parseResolution(lines, resolution, endIndex, item.acId),
    };
  });
  return { ac_matrix: acMatrix };
}

export function validateCloseGateReport(report, source) {
  if (!report || !Array.isArray(report.ac_matrix)) {
    return [`[${source}] close_gate_report.ac_matrix must be an array`];
  }

  const blockers = [];
  for (const [index, ac] of report.ac_matrix.entries()) {
    const acId = nonEmptyString(ac?.ac_id) ? ac.ac_id : `ac_matrix[${index}]`;
    if (ac.status === 'met') {
      if (!Array.isArray(ac.evidence) || ac.evidence.length === 0) {
        blockers.push(`[${source}] ${acId}: met status requires evidence`);
      }
      if (ac.resolution !== null && ac.resolution !== undefined) {
        blockers.push(`[${source}] ${acId}: met status resolution must be null`);
      }
    } else if (ac.status === 'unmet') {
      blockers.push(`[${source}] ${acId}: AC is still unmet; resolve it before close`);
    } else if (ac.status === 'deleted') {
      if (ac.resolution?.kind !== 'delete' || !nonEmptyString(ac.resolution?.reason)) {
        blockers.push(`[${source}] ${acId}: deleted status requires delete resolution with reason`);
      }
    } else if (ac.status === 'cvo_signed_off') {
      if (ac.resolution?.kind !== 'cvo_signoff') {
        blockers.push(`[${source}] ${acId}: cvo_signed_off requires cvo_signoff resolution`);
        continue;
      }
      const signoff = ac.resolution.cvo_signoff;
      for (const field of ['proposal_message_id', 'cvo_message_id', 'cvo_quote']) {
        if (!nonEmptyString(signoff?.[field])) {
          blockers.push(`[${source}] ${acId}: cvo_signoff missing ${field}`);
        }
      }
      if (!Array.isArray(signoff?.accepted_scope) || !signoff.accepted_scope.includes(acId)) {
        blockers.push(`[${source}] ${acId}: cvo_signoff accepted_scope must include ${acId}`);
      }
    } else {
      blockers.push(`[${source}] ${acId}: unknown status ${JSON.stringify(ac.status)}`);
    }
  }
  return blockers;
}
