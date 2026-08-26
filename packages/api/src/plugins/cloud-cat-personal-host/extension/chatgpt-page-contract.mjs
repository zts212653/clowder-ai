export const SAFE_CONVERSATION_ID = /^[A-Za-z0-9-]+$/;

export function conversationIdFromLocation(location) {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') return null;
  return location.pathname.match(/^\/c\/([A-Za-z0-9-]+)\/?$/)?.[1] ?? null;
}

export function firstMatch(document, selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

export class ChatGptPageAdapterError extends Error {
  constructor(code, message, diagnostic) {
    super(message);
    this.name = 'ChatGptPageAdapterError';
    this.code = code;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

export function requireExactString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new ChatGptPageAdapterError('INVALID_REQUEST', `${label} must be a non-empty exact string`);
  }
  return value;
}

export function requireContentString(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > 128 * 1024
  ) {
    throw new ChatGptPageAdapterError('INVALID_REQUEST', 'text must contain at most 131072 bytes');
  }
  return value;
}

export function requireTimeout(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', `${label} must be between ${minimum} and ${maximum}`);
  }
}

const COMPOSER_BLOCK_TAGS = new Set(['DIV', 'P']);
const DOM_FINGERPRINT_NODE_LIMIT = 12;
const DOM_FINGERPRINT_DEPTH_LIMIT = 6;
const DOM_FINGERPRINT_TAG = /^[A-Z][A-Z0-9-]{0,31}$/;
const DOM_FINGERPRINT_TOKEN = /^[A-Za-z0-9._:-]+$/;
const MAX_DOM_CHILD_INDEX = 0xffff_ffff;

function boundedFingerprintToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && DOM_FINGERPRINT_TOKEN.test(value)
    ? value
    : 'unavailable';
}

function boundedNodeType(value, markTruncated) {
  if (Number.isInteger(value) && value >= 0 && value <= 1_000) return value;
  markTruncated();
  return 0;
}

function childPath(parentPath, child, index, markTruncated = () => undefined) {
  const nodeType = boundedNodeType(child.nodeType, markTruncated);
  const safeTag = child.nodeType === child.ELEMENT_NODE && DOM_FINGERPRINT_TAG.test(child.tagName);
  if (child.nodeType === child.ELEMENT_NODE && !safeTag) markTruncated();
  const safeIndex = Number.isInteger(index) && index >= 0 && index <= MAX_DOM_CHILD_INDEX;
  if (!safeIndex) markTruncated();
  const name =
    child.nodeType === child.ELEMENT_NODE
      ? safeTag
        ? child.tagName.toLowerCase()
        : `#node-${nodeType}`
      : child.nodeType === child.TEXT_NODE
        ? '#text'
        : `#node-${nodeType}`;
  return `${parentPath}/${name}[${safeIndex ? index : MAX_DOM_CHILD_INDEX}]`;
}

function fingerprintNode(node, path, markTruncated) {
  if (node.nodeType === node.TEXT_NODE) {
    return { path, kind: 'text', empty: node.data.length === 0 };
  }
  if (node.nodeType !== node.ELEMENT_NODE) {
    return { path, kind: 'other', nodeType: boundedNodeType(node.nodeType, markTruncated) };
  }
  const safeTag = DOM_FINGERPRINT_TAG.test(node.tagName);
  if (!safeTag) markTruncated();
  const childCount = node.childNodes.length;
  if (!Number.isInteger(childCount) || childCount < 0 || childCount > MAX_DOM_CHILD_INDEX) markTruncated();
  return {
    path,
    kind: 'element',
    ...(safeTag ? { tag: node.tagName } : {}),
    childCount:
      Number.isInteger(childCount) && childCount >= 0 ? Math.min(childCount, MAX_DOM_CHILD_INDEX) : MAX_DOM_CHILD_INDEX,
    contentEditable: node.getAttribute('contenteditable') === 'true',
    proseMirror: node.classList.contains('ProseMirror'),
    placeholder: node.hasAttribute('data-placeholder'),
    virtualKeyboard: node.hasAttribute('data-virtualkeyboard'),
    trailingBreak: node.classList.contains('ProseMirror-trailingBreak'),
  };
}

export function composerDomFingerprint(
  element,
  {
    phase = 'before_submit',
    adapterRevision = 'unversioned',
    artifactRevision = 'unversioned',
    firstUnsupportedPath,
  } = {},
) {
  const nodes = [];
  let truncated = false;
  const visit = (node, path, depth) => {
    if (nodes.length >= DOM_FINGERPRINT_NODE_LIMIT || depth > DOM_FINGERPRINT_DEPTH_LIMIT) {
      truncated = true;
      return;
    }
    const markTruncated = () => {
      truncated = true;
    };
    nodes.push(fingerprintNode(node, path, markTruncated));
    for (const [index, child] of [...node.childNodes].entries()) {
      visit(child, childPath(path, child, index, markTruncated), depth + 1);
    }
  };
  visit(element, 'composer', 0);
  return {
    v: 1,
    phase: boundedFingerprintToken(phase),
    adapterRevision: boundedFingerprintToken(adapterRevision),
    artifactRevision: boundedFingerprintToken(artifactRevision),
    nodes,
    truncated,
    ...(firstUnsupportedPath ? { firstUnsupportedPath } : {}),
  };
}

function directDomText(node, path) {
  let value = '';
  for (const [index, child] of [...node.childNodes].entries()) {
    if (child.nodeType === child.TEXT_NODE) {
      value += child.data;
      continue;
    }
    if (child.nodeType === child.ELEMENT_NODE && child.tagName === 'BR' && child.childNodes.length === 0) {
      if (child.classList.contains('ProseMirror-trailingBreak')) {
        if (index !== node.childNodes.length - 1) {
          return { status: 'unsupported', path: childPath(path, child, index) };
        }
        continue;
      }
      value += '\n';
      continue;
    }
    return { status: 'unsupported', path: childPath(path, child, index) };
  }
  return { status: 'ok', text: value };
}

export function inspectContentEditableText(element) {
  const children = [...element.childNodes];
  if (children.length === 0) return { status: 'ok', text: '' };
  const hasBlockNormalization = children.every(
    (child) => child.nodeType === child.ELEMENT_NODE && COMPOSER_BLOCK_TAGS.has(child.tagName),
  );
  if (!hasBlockNormalization) return directDomText(element, 'composer');
  const lines = [];
  for (const [index, block] of children.entries()) {
    const blockPath = childPath('composer', block, index);
    const line = directDomText(block, blockPath);
    if (line.status === 'unsupported') return line;
    lines.push(block.childNodes.length === 1 && block.firstChild?.nodeName === 'BR' ? '' : line.text);
  }
  return { status: 'ok', text: lines.join('\n') };
}

export function contentEditableText(element) {
  const result = inspectContentEditableText(element);
  return result.status === 'ok' ? result.text : null;
}
