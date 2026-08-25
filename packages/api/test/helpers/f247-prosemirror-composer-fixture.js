import { readFileSync } from 'node:fs';

const observedComposerShape = JSON.parse(
  readFileSync(new URL('../fixtures/f247-chatgpt-prosemirror-composer-shape.json', import.meta.url), 'utf8'),
);

function appendShapeNode(document, parent, shape, lines = []) {
  if (shape.kind === 'text') {
    parent.append(document.createTextNode(lines[shape.lineIndex]));
    return;
  }
  const element = document.createElement(shape.tag);
  if (shape.placeholder) element.dataset.placeholder = 'redacted';
  if (shape.trailingBreak) element.classList.add('ProseMirror-trailingBreak');
  for (const child of shape.children) appendShapeNode(document, element, child, lines);
  parent.append(element);
}

export function restoreObservedEmptyShape(document, composer) {
  composer.replaceChildren();
  for (const child of observedComposerShape.composer.children) appendShapeNode(document, composer, child);
}

export function replaceWithObservedInsertedShape(document, composer, text) {
  const lines = text.split('\n');
  composer.replaceChildren();
  for (const child of observedComposerShape.insertedComposer.children) {
    appendShapeNode(document, composer, child, lines);
  }
}

export function replaceWithOrdinaryHardBreak(document, composer) {
  const first = document.createElement('p');
  const trailingBreak = document.createElement('br');
  trailingBreak.classList.add('ProseMirror-trailingBreak');
  first.append('alpha', document.createElement('br'), 'beta', trailingBreak);
  const second = document.createElement('p');
  second.append('gamma');
  composer.replaceChildren(first, second);
}

export function replaceWithMisplacedTrailingBreak(document, composer) {
  const paragraph = document.createElement('p');
  const trailingBreak = document.createElement('br');
  trailingBreak.classList.add('ProseMirror-trailingBreak');
  paragraph.append('alpha', trailingBreak, 'beta');
  composer.replaceChildren(paragraph);
}

export function observedComposerText(composer) {
  return [...composer.children]
    .map((block) => {
      if (block.childNodes.length === 1 && block.firstChild?.nodeName === 'BR') return '';
      return [...block.childNodes]
        .map((node) => {
          if (node.nodeType === node.TEXT_NODE) return node.data;
          if (node.nodeType !== node.ELEMENT_NODE || node.tagName !== 'BR') return '';
          return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
        })
        .join('');
    })
    .join('\n');
}
