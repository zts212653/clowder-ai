import { randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { z } from 'zod';
import {
  currentControlLabel,
  currentControlOperation,
  currentControlVisible,
  permittedCurrentControl,
} from './CurrentPageControlTask.js';

interface Element {
  tagName: string;
  parentElement: Element | null;
  children: ArrayLike<Element>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; right: number; top: number; bottom: number; width: number; height: number };
  matches(selector: string): boolean;
  contains(element: Element): boolean;
}
declare const document: { querySelectorAll(selector: string): ArrayLike<Element> };
declare const location: { href: string };

export function currentControlPath(element: Element): string | null {
  const path = [];
  let node: Element | null = element;
  while (node && path.length < 32) {
    const parent: Element | null = node.parentElement;
    if (parent && parent.children.length > 4096) return null;
    const siblings: Element[] = parent
      ? Array.from(parent.children).filter((child) => child.tagName === node?.tagName)
      : [node];
    path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    node = parent;
  }
  return node ? null : path.join('>');
}

/** Serialized into an isolated world. Only labels/types/paths are returned, never field values or page text. */
export function discoverCurrentPageControls() {
  const controls = document.querySelectorAll('button,[role="button"],a[href],input,textarea');
  const targets = [];
  for (let i = 0; i < Math.min(controls.length, 512); i++) {
    const element = controls[i];
    if (!element) continue;
    const operation = currentControlOperation(element);
    if (!operation || !permittedCurrentControl(element, operation)) continue;
    const label = currentControlLabel(element);
    const selector = currentControlPath(element);
    if (!label || !selector) continue;
    targets.push({
      id: `control-${targets.length}`,
      selector,
      operation,
      label,
    });
    if (targets.length === 32) break;
  }
  return { url: location.href, targets };
}

const discovery = z
  .object({
    url: z.string().max(2048),
    targets: z
      .array(
        z
          .object({
            id: z.string().regex(/^control-\d+$/),
            selector: z.string().max(4096),
            operation: z.enum(['click', 'fill']),
            label: z.string().min(1).max(512),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export async function discoverOwnerCurrentPage(page: Page) {
  const session = await page.createCDPSession();
  try {
    await session.send('Page.enable');
    const tree = await session.send('Page.getFrameTree');
    const world = await session.send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: `cat-cafe-discovery-${randomUUID()}`,
      grantUniveralAccess: false,
    });
    const result = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const __name = (fn) => fn;
        const currentControlVisible = ${currentControlVisible.toString()};
        const currentControlOperation = ${currentControlOperation.toString()};
        const currentControlLabel = ${currentControlLabel.toString()};
        const permittedCurrentControl = ${permittedCurrentControl.toString()};
        const currentControlPath = ${currentControlPath.toString()};
        return (${discoverCurrentPageControls.toString()})();
      })()`,
      contextId: world.executionContextId,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Current page discovery unavailable');
    return discovery.parse(result.result.value);
  } finally {
    await session.detach();
  }
}
