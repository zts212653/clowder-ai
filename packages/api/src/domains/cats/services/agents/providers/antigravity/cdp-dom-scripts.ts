/**
 * Inline JavaScript strings evaluated inside the Antigravity page via CDP Runtime.evaluate.
 *
 * Extracted from AntigravityCdpClient to keep the main file under the 350-line limit.
 * These are raw JS strings (not TypeScript) — they run in the Electron renderer process.
 */

/** Extract assistant response state from the DOM after a user message.
 *  Returns JSON: { userMsgCount, responseText, thinkingText, hasInlineLoading, hasStopButton }
 *
 *  Antigravity IDE DOM structure (as of 2026-04):
 *    .antigravity-agent-side-panel
 *      └ .overflow-y-auto
 *          └ .mx-auto.w-full > div
 *              └ .flex.min-w-0.grow.flex-col          ← turn container
 *                  ├ div.group.pt-4                   ← user turn (contains .whitespace-pre-wrap in .max-h-[20vh])
 *                  ├ div (relative)                   ← assistant: "Worked for Xs" + response blocks
 *                  │   ├ .group "Worked for Xs"
 *                  │   ├ .relative > .group "Thought for Xs" + collapsed thinking
 *                  │   ├ .leading-relaxed.select-text  ← main response text
 *                  │   └ ...tool-use, terminal, file-diff blocks
 *                  ├ div.group.pt-4                   ← next user turn
 *                  └ ...
 */
export const POLL_RESPONSE_JS = `(() => {
  // --- 0. Visibility helpers ---
  // Check if an element is visually hidden using computed styles (reliable),
  // not class names alone (fragile — e.g. opacity-0 can be overridden by state classes).
  const isVisiblyHidden = (el) => {
    if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) return false;
    try {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      if (parseFloat(cs.opacity) < 0.01) return true;
      if (parseInt(cs.maxHeight, 10) === 0 && cs.overflow !== 'visible') return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.hasAttribute('inert')) return true;
      if (el.clientHeight === 0 && el.scrollHeight > 0) return true;
    } catch(e) { /* detached node or cross-origin — fall through */ }
    return false;
  };

  // Icon names used by Material Symbols — matched individually OR as concatenated runs
  const ICON_NAMES = ['content_copy','thumb_up','thumb_down','check','close','chevron_right','chevron_left','undo','keyboard_arrow_up','expand_more','expand_less','more_vert','more_horiz','edit','delete','share','download','play_arrow','stop','send','arrow_upward','arrow_downward','refresh','settings','info','warning','error','help','search','menu','add','remove','visibility','visibility_off','lock','lock_open','star','star_border','favorite','favorite_border'];
  const ICON_CONCAT_RE = new RegExp('(' + ICON_NAMES.join('|') + '){2,}', 'gi');

  // --- 1. Identify user messages ---
  // User messages are DIV.whitespace-pre-wrap inside DIV.max-h-[20vh] inside DIV.group.pt-4
  // Must filter out: PRE (terminal output), CODE (inline code), system context blocks
  const userMsgs = [...document.querySelectorAll('.whitespace-pre-wrap')].filter((el) => {
    // Skip terminal output (PRE tags) and code blocks (CODE tags)
    if (el.tagName === 'PRE' || el.tagName === 'CODE') return false;
    // Skip context-injected system prompt blocks — but NOT legitimate user messages.
    // Cat-cafe prompts may contain 'Identity:' in the user message body, so we cannot
    // simply reject long text with that keyword. Instead: if the element is inside a
    // recognised user-turn group (.group.pt-4), keep it regardless of length/content.
    // Only reject if it matches ALL of: very long, has system-prompt markers, AND is
    // NOT inside a user-turn group.
    const text = el.textContent || '';
    const group = el.closest('.group');
    const inUserTurnGroup = group && group.classList.contains('pt-4');
    if (!inUserTurnGroup && text.length > 2000 && text.includes('Identity:')) return false;
    // Skip elements inside opacity-70 (thinking blocks)
    if (el.closest('.opacity-70')) return false;
    // Must be inside a user turn group (.group with .pt-4) to be a real user message
    if (group && !group.classList.contains('pt-4')) return false;
    return true;
  });
  const lastUserMsg = userMsgs[userMsgs.length - 1];

  // --- 2. Text extraction helper ---
  const extractBlockText = (block, skipRootGuard) => {
    const clone = block.cloneNode(true);
    // Guard: if root element itself is hidden/invisible, return empty
    // (skipped for thinking containers which are intentionally collapsed)
    if (!skipRootGuard) {
      const rootCls = (typeof clone.className === 'string') ? clone.className : '';
      if (/\\bopacity-0\\b/.test(rootCls) || /\\bmax-h-0\\b/.test(rootCls) || /\\bhidden\\b/.test(rootCls) || /\\bpointer-events-none\\b/.test(rootCls)) {
        return '';
      }
    }
    // Strip hidden subtrees, icons, scripts, styles
    clone.querySelectorAll('style, script, [aria-hidden="true"], [inert], .google-symbols, [class*="symbol"], [class*="material-symbols"]').forEach((el) => el.remove());
    for (const el of clone.querySelectorAll('*')) {
      const cls = el.className || '';
      if (typeof cls === 'string' && (/\\bmax-h-0\\b/.test(cls) || /\\bopacity-0\\b/.test(cls) || /\\bhidden\\b/.test(cls))) {
        el.remove();
      }
      // Strip UI icon text (Material Symbols icon labels rendered as text)
      const txt = (el.textContent || '').trim();
      if (['content_copy','thumb_up','thumb_down','check','close','chevron_right','chevron_left','undo','keyboard_arrow_up','expand_more','expand_less','more_vert','more_horiz','edit','delete','share','download','play_arrow','stop','send'].includes(txt)) {
        el.remove();
      }
    }
    // Strip buttons (e.g. "Thought for Xs" toggle, action buttons)
    clone.querySelectorAll('button').forEach((el) => el.remove());
    // Strip toolbar/action-bar containers (copy/vote buttons area)
    clone.querySelectorAll('[class*="justify-between"][class*="cursor-default"]').forEach((el) => el.remove());
    const structured = [...clone.querySelectorAll('p, li, pre, code, h1, h2, h3, h4, h5, h6')]
      .map((el) => el.textContent?.trim()).filter(Boolean);
    if (structured.length > 0) return structured.join('\\n');
    return clone.textContent?.trim() || '';
  };

  // --- 3. Find assistant response blocks ---
  // DOM structure per conversation turn:
  //   div.flex.flex-col.gap-0.5  (turn wrapper)
  //     sticky header -> flex-row -> min-w-0 -> group.pt-4 (user message)
  //     div (assistant: "Worked for Xs", .leading-relaxed blocks, tool-use)
  //     div.whitespace-nowrap (status indicator, opacity-0)
  // Multiple turn wrappers are children of:
  //   div.relative.flex.flex-col.gap-y-3.px-4 (conversation container)
  // Strategy: walk up from userTurnGroup to find the level where assistant blocks are siblings.
  const assistantBlocks = (() => {
    if (!lastUserMsg) return [];
    const userTurnGroup = lastUserMsg.closest('.group.pt-4')
      || lastUserMsg.closest('.group')
      || lastUserMsg.parentElement;
    if (!userTurnGroup) return [];

    // Walk up ancestor levels until we find siblings with .leading-relaxed
    let current = userTurnGroup;
    for (let depth = 0; depth < 6; depth++) {
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = [...parent.children];
      const myIdx = siblings.indexOf(current);
      const afterMe = siblings.slice(myIdx + 1);
      // Check if any sibling has a .leading-relaxed response block
      const hasSibWithResponse = afterMe.some(s =>
        s.querySelector && s.querySelector('.leading-relaxed')
      );
      if (hasSibWithResponse) {
        return afterMe.filter(s => {
          if (!s.textContent?.trim()) return false;
          // Skip invisible status indicators using computed styles
          if (isVisiblyHidden(s)) return false;
          return true;
        });
      }
      // Also check if parent is the per-turn conversation container (gap-y-3)
      const parentCls = parent.className || '';
      if (parentCls.includes('gap-y-3')) {
        const turnIdx = siblings.indexOf(current);
        const blocks = [];
        for (let j = turnIdx + 1; j < siblings.length; j++) {
          const turn = siblings[j];
          const nextUserGroup = turn.querySelector('.group.pt-4 .whitespace-pre-wrap');
          if (nextUserGroup) break;
          if (turn.textContent?.trim() && !isVisiblyHidden(turn)) {
              blocks.push(turn);
          }
        }
        return blocks;
      }
      current = parent;
    }
    // Fallback: sibling-walk from userTurnGroup parent
    const fp = userTurnGroup.parentElement;
    if (!fp) return [];
    const allTurns = [...fp.children];
    const ui = allTurns.indexOf(userTurnGroup);
    if (ui < 0) return [];
    const blocks = [];
    for (let i = ui + 1; i < allTurns.length; i++) {
      const turn = allTurns[i];
      if (turn.classList.contains('group') && turn.classList.contains('pt-4')
          && turn.querySelector('.whitespace-pre-wrap')) break;
      if (turn.textContent?.trim() && !isVisiblyHidden(turn)) {
          blocks.push(turn);
      }
    }
    return blocks;
  })();

  // --- 4. Extract thinking and response text ---
  const thinkingParts = [];
  const responseParts = [];
  for (const b of assistantBlocks) {
    // Check for .leading-relaxed.select-text — this is the main response text block
    // Filter out any that are inside collapsed thinking containers (max-h-0/opacity-0)
    const responseEls = [...b.querySelectorAll('.leading-relaxed.select-text')].filter(el => {
      // Primary: check computed visibility on original DOM element (handles class overrides)
      if (isVisiblyHidden(el)) return false;
      // Walk ancestors up to block boundary — if any ancestor is hidden, exclude
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== b) {
        if (isVisiblyHidden(ancestor)) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    });
    // Detect thinking: <details>, [class*="thinking"], [class*="thought"],
    // or "Thought for Xs" button + adjacent collapsed container, or opacity-70 blocks
    const thinkEls = b.querySelectorAll('details, [class*="thinking"], [class*="thought"]');
    const thoughtBtn = [...b.querySelectorAll('button')].find((btn) =>
      /^Thought\\s+for\\s/i.test((btn.textContent || '').trim())
    );
    const isOpacityThinking = b.classList.contains('opacity-70') || !!b.querySelector('.opacity-70');
    const hasThinking = thinkEls.length > 0 || !!thoughtBtn || isOpacityThinking;

    if (hasThinking) {
      if (isOpacityThinking && responseEls.length === 0) {
        // Pure thinking block (opacity-70 only, no response text)
        thinkingParts.push(extractBlockText(b, true));
      } else {
        // Collect thinking text from recognized thinking elements
        for (const el of thinkEls) thinkingParts.push((el.textContent || '').trim());
        if (thoughtBtn) {
          // Antigravity thought: collect from collapsed sibling containers
          let sib = thoughtBtn.nextElementSibling;
          while (sib) {
            const cls = sib.className || '';
            if (typeof cls === 'string' && (/\\bmax-h-0\\b/.test(cls) || /\\bopacity-0\\b/.test(cls))) {
              thinkingParts.push(extractBlockText(sib, true));
            } else { break; }
            sib = sib.nextElementSibling;
          }
        }
      }

      // Extract response text from .leading-relaxed blocks if present
      if (responseEls.length > 0) {
        for (const rel of responseEls) {
          // Skip if inside a collapsed/hidden thinking container
          const parentCls = rel.parentElement?.className || '';
          if (/\\bmax-h-0\\b/.test(parentCls) || /\\bopacity-0\\b/.test(parentCls)) continue;
          const txt = extractBlockText(rel).trim();
          if (txt) responseParts.push(txt);
        }
      } else if (!isOpacityThinking) {
        // Fallback: clone block, strip thinking elements, extract remainder
        const clone = b.cloneNode(true);
        clone.querySelectorAll('details, [class*="thinking"], [class*="thought"]').forEach((el) => el.remove());
        for (const btn of [...clone.querySelectorAll('button')]) {
          if (/^Thought\\s+for\\s/i.test((btn.textContent || '').trim())) {
            let ns = btn.nextElementSibling;
            while (ns) {
              const c = ns.className || '';
              if (typeof c === 'string' && (/\\bmax-h-0\\b/.test(c) || /\\bopacity-0\\b/.test(c))) {
                const next = ns.nextElementSibling; ns.remove(); ns = next;
              } else { break; }
            }
            btn.remove();
          }
        }
        const remaining = extractBlockText(clone).trim();
        if (remaining) responseParts.push(remaining);
      }
    } else if (responseEls.length > 0) {
      // No thinking, but has .leading-relaxed response blocks
      for (const rel of responseEls) {
        const txt = extractBlockText(rel).trim();
        if (txt) responseParts.push(txt);
      }
    } else {
      // Generic block — extract all text
      const txt = extractBlockText(b).trim();
      if (txt) responseParts.push(txt);
    }
  }
  // --- Final text normalization: strip icon text artifacts ---
  const stripIconArtifacts = (text) => {
    let cleaned = text;
    // Remove concatenated icon runs (e.g. 'content_copythumb_upthumb_down')
    cleaned = cleaned.replace(ICON_CONCAT_RE, '');
    // Collapse multiple blank lines left by removals
    cleaned = cleaned.replace(/\\n{3,}/g, '\\n\\n').trim();
    return cleaned;
  };
  const responseText = stripIconArtifacts(responseParts.join('\\n').trim());
  const thinkingText = thinkingParts.filter(Boolean).join('\\n').trim();

  // --- 5. Detect loading / stop button ---
  const hasInlineLoading = assistantBlocks.some((b) => !!b.querySelector('.codicon-loading, [aria-busy="true"]'));
  const panel = document.querySelector('.antigravity-agent-side-panel');
  const chatScope = panel || document.querySelector('[role="textbox"]')?.closest('.overflow-y-auto, [class*="chat"], [class*="conversation"]')?.parentElement;
  let hasStopButton = false;
  if (chatScope) {
    const stopBtn = chatScope.querySelector('button[aria-label*="stop" i]:not([disabled]), button[aria-label*="cancel" i]:not([disabled]), button[title*="stop" i]:not([disabled])');
    hasStopButton = !!(stopBtn && stopBtn.offsetParent !== null);
  }
  return JSON.stringify({ userMsgCount: userMsgs.length, responseText, thinkingText, hasInlineLoading, hasStopButton });
})()`;

/** Find the "new conversation" button via multiple DOM strategies.
 *  Returns JSON: { x, y } or null. */
/** Find the send/submit button near the chat input.
 *  Real DOM: <button class="flex items-center p-1 rounded-full...">Send</button>
 *  in a sibling branch of the textbox container, not inside its ancestor tree.
 *  Returns JSON: { x, y } or null. */
export const FIND_SEND_BUTTON_JS = `(() => {
  // Strategy 1: walk up from textbox to find send button in sibling branch
  // (scoped to composer area — preferred over global matching to avoid toolbar false positives)
  // Sub-pass A: prefer button with send/submit text; Sub-pass B: any small button as fallback
  const textbox = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (textbox) {
    for (let ancestor = textbox.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const btns = ancestor.querySelectorAll('button:not([disabled])');
      const siblings = [...btns].filter(b => !b.contains(textbox));
      if (siblings.length === 0) continue;
      // Sub-pass A: prefer button whose text is "send" or "submit"
      for (const btn of siblings) {
        const t = (btn.textContent || '').trim().toLowerCase();
        if (t === 'send' || t === 'submit') {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        }
      }
      // Sub-pass B: any small visible button (e.g. icon-only send)
      for (const btn of siblings) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 80) {
          return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
        }
      }
      break;
    }
  }
  // Strategy 2: button whose visible text is "Send" or "Submit" (global fallback)
  for (const btn of document.querySelectorAll('button')) {
    if (btn.disabled) continue;
    const t = (btn.textContent || '').trim().toLowerCase();
    if (t === 'send' || t === 'submit') {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    }
  }
  // Strategy 3: button with send/submit aria-label/title, or codicon-send icon
  for (const btn of document.querySelectorAll('button')) {
    if (btn.disabled) continue;
    const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
    if (label.includes('send') || label.includes('submit')) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    }
  }
  const sendIcon = document.querySelector('.codicon-send');
  if (sendIcon) {
    const btn = sendIcon.closest('button, a') || sendIcon;
    const r = btn.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
  }
  return null;
})()`;

/** Dispatch Enter key via JS KeyboardEvent on the active element.
 *  More reliable than CDP Input.dispatchKeyEvent for Lexical editors. */
export const DISPATCH_ENTER_JS = `(() => {
  const el = document.activeElement;
  if (!el) return false;
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
})()`;

/** Read the currently selected model label from the Antigravity model selector.
 *  Real DOM: <span class="...select-none...text-xs opacity-70">Gemini 3.1 Pro (High)</span>
 *  inside a cursor-pointer flex container. */
export const GET_CURRENT_MODEL_JS = `(() => {
  const MODEL_RE = /gemini|claude|gpt|opus|sonnet|flash/i;
  const span = document.querySelector('span.select-none[class*="opacity"]');
  if (span && MODEL_RE.test(span.textContent || '')) return span.textContent.trim();
  for (const el of document.querySelectorAll('[class*="cursor-pointer"] span, [class*="cursor-pointer"]')) {
    const t = (el.textContent || '').trim();
    if (MODEL_RE.test(t) && t.length < 60) return t;
  }
  return null;
})()`;

/** Click the model selector to open the dropdown.
 *  Real DOM: parent div with cursor-pointer containing model label span.
 *  Returns JSON { x, y } of the clickable element, or null. */
export const CLICK_MODEL_SELECTOR_JS = `(() => {
  const MODEL_RE = /gemini|claude|gpt|opus|sonnet|flash/i;
  const span = document.querySelector('span.select-none[class*="opacity"]');
  if (span && MODEL_RE.test(span.textContent || '')) {
    const clickTarget = span.closest('[class*="cursor-pointer"]') || span;
    const r = clickTarget.getBoundingClientRect();
    if (r.width > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
  }
  for (const el of document.querySelectorAll('[class*="cursor-pointer"]')) {
    const t = (el.textContent || '').trim();
    if (MODEL_RE.test(t) && t.length < 60) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    }
  }
  return null;
})()`;

/** Find and click a model option in the open dropdown by label substring.
 *  Argument: __TARGET__ will be replaced at call time.
 *  Returns true if clicked, false if not found. */
export const FIND_MODEL_OPTION_JS = `(() => {
  const visible = e => e.offsetParent !== null && e.offsetHeight > 0 && e.offsetHeight < 60;
  const options = [...document.querySelectorAll(
    '[role="option"], [role="menuitem"], [role="menuitemradio"], ' +
    '[class*="cursor-pointer"][class*="py-1"], [class*="cursor-pointer"][class*="hover\\\\:"]'
  )].filter(visible);
  const target = __TARGET__;
  for (const opt of options) {
    if ((opt.textContent || '').toLowerCase().includes(target)) { opt.click(); return true; }
  }
  return false;
})()`;

export const NEW_CONVERSATION_JS = `(() => {
  const candidates = document.querySelectorAll('a, button');
  for (const el of candidates) {
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
    if (label.includes('new') && (label.includes('chat') || label.includes('conversation'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    }
  }
  const icons = document.querySelectorAll('.codicon-add, [class*="plus"]');
  for (const icon of icons) {
    const clickable = icon.closest('a, button');
    if (clickable) {
      const r = clickable.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.y < 80) return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
    }
  }
  const links = document.querySelectorAll('a.group.relative');
  for (const a of links) {
    const r = a.getBoundingClientRect();
    if (r.y > 20 && r.y < 80 && r.width < 50 && r.width > 0)
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
  }
  return null;
})()`;
