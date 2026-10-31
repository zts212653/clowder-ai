/** DOM-side measurements for the F322 reply-layers browser contract. */
export function measureReply() {
  return (id) => {
    const toRgb = (css) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0], data[1], data[2]];
    };
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, w: box.width, h: box.height, r: box.right, b: box.bottom };
    };
    const colorOf = (element) => (element ? toRgb(getComputedStyle(element).color) : null);
    const statusMetrics = (element) =>
      element
        ? {
            text: element.textContent,
            kind: element.getAttribute('data-status'),
            color: colorOf(element),
            fontSize: getComputedStyle(element).fontSize,
          }
        : null;
    const dotMetrics = (element) =>
      element
        ? {
            rect: rect(element),
            tone: element.getAttribute('data-tone'),
            shape: element.dataset.testid === 'reply-activity-cat' ? 'cat' : 'dot',
            bg: toRgb(
              getComputedStyle(element)[element.dataset.testid === 'reply-activity-cat' ? 'color' : 'backgroundColor'],
            ),
            radius: getComputedStyle(element).borderTopLeftRadius,
            ring: getComputedStyle(element).boxShadow,
          }
        : null;
    const paramMetrics = (element) =>
      element
        ? {
            text: element.textContent,
            rect: rect(element),
            family: getComputedStyle(element).fontFamily,
            truncated: element.scrollWidth > element.clientWidth + 1,
          }
        : null;
    const summaryMetrics = (wrapper, toggle) => {
      if (toggle) return { text: toggle.textContent, color: colorOf(toggle) };
      const summary = wrapper?.querySelector('[data-testid="reply-record-summary"]');
      return summary ? { text: summary.textContent } : null;
    };
    const bodyMetrics = (element) =>
      element
        ? {
            fontSize: getComputedStyle(element).fontSize,
            lineHeight: getComputedStyle(element).lineHeight,
            rect: rect(element),
          }
        : null;
    const wrapper = document.querySelector(`[data-message-id="${id}"]`);
    const column = document.querySelector('[data-testid="column"]');
    const line = wrapper?.querySelector('[data-testid="reply-last-line"]');
    const status = wrapper?.querySelector('[data-testid="reply-status"]');
    const dot = wrapper?.querySelector('[data-testid="reply-status-dot"], [data-testid="reply-activity-cat"]');
    const param = wrapper?.querySelector('[data-testid="reply-status-param"]');
    const reroute = wrapper?.querySelector('[data-testid="reply-reroute"]');
    const bubble = wrapper?.querySelector('[data-testid="message-bubble"]');
    const paragraph = bubble?.querySelector('p');
    const toggle = wrapper?.querySelector('[data-testid="reply-record-toggle"]');
    const background = toRgb(getComputedStyle(column).backgroundColor);
    const record = wrapper?.querySelector('[data-testid="reply-record"]');
    return {
      exists: Boolean(wrapper),
      hasLine: Boolean(line),
      line: rect(line),
      lineFont: line ? getComputedStyle(line).fontSize : null,
      status: statusMetrics(status),
      dot: dotMetrics(dot),
      param: paramMetrics(param),
      reroute: reroute ? { text: reroute.textContent, color: colorOf(reroute) } : null,
      summary: summaryMetrics(wrapper, toggle),
      trajectory: Boolean(wrapper?.querySelector('[data-testid="reply-trajectory"]')),
      bodyPara: bodyMetrics(paragraph),
      bubble: rect(bubble),
      record: rect(record),
      column: rect(column),
      columnScroll: { scrollWidth: column.scrollWidth, clientWidth: column.clientWidth },
      bg: background,
      cliBlock:
        Boolean(wrapper?.querySelector('[data-testid="cli-output-body"]')) ||
        (wrapper?.textContent ?? '').includes('CLI Output'),
      nameRowAnchor: Boolean(wrapper?.querySelector('[data-testid="message-header"] [data-invocation-anchor]')),
    };
  };
}

const linear = (value) => {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
};

const luminance = ([red, green, blue]) => 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);

export function contrast(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
}

/** Actual paint and typography of the child record, including compact last-line counters. */
export function measureSubexecutionRecord(node) {
  const rgb = (css) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const rect = (element) => element?.getBoundingClientRect().toJSON();
  const group = node.querySelector('[data-testid="reply-subexecutions"]');
  const column = node.closest('[data-thread-chat-reading-column]');
  const bubble = node.querySelector('[data-testid="message-bubble"]');
  return {
    column: rect(column),
    columnClient: column.clientWidth,
    columnScroll: column.scrollWidth,
    rowClient: node.clientWidth,
    rowScroll: node.scrollWidth,
    groupClient: group.clientWidth,
    groupScroll: group.scrollWidth,
    line: rect(node.querySelector('[data-testid="reply-last-line"]')),
    headerParts: [...group.querySelectorAll('[data-testid="reply-subexecution-group-title"] > span')].map((part) => ({
      text: part.textContent,
      rect: rect(part),
      whiteSpace: getComputedStyle(part).whiteSpace,
    })),
    counters: [...node.querySelectorAll('[data-subexecution-count]')]
      .filter((part) => part.getBoundingClientRect().width > 0)
      .map((part) => ({
        kind: part.dataset.subexecutionCount,
        text: part.textContent,
        rect: rect(part),
        parent: rect(part.closest('button')),
      })),
    motherRail: getComputedStyle(bubble).borderLeftWidth,
    children: [...group.querySelectorAll('[data-subexecution-id]')].map((child) => {
      const name = child.querySelector('[data-subexecution-name]');
      const header = child.querySelector('button');
      return {
        id: child.dataset.subexecutionId,
        rect: rect(child),
        client: child.clientWidth,
        scroll: child.scrollWidth,
        button: rect(header),
        name: rect(name),
        nameWeight: getComputedStyle(name).fontWeight,
        task: rect(child.querySelector('[data-subexecution-task]')),
        state: rect(child.querySelector('[data-subexecution-state]')),
        stateFont: getComputedStyle(child.querySelector('[data-subexecution-state]')).fontSize,
        durationFont: getComputedStyle(child.querySelector('[data-subexecution-duration]')).fontSize,
        details: [...child.querySelectorAll('[data-subexecution-message-phase]')].slice(0, 1).map((message) => ({
          font: getComputedStyle(message.firstElementChild).fontSize,
          weight: getComputedStyle(message.firstElementChild).fontWeight,
          border: getComputedStyle(message.parentElement).borderInlineStartWidth,
          gap: getComputedStyle(message.parentElement).rowGap,
        })),
        duration: rect(child.querySelector('[data-subexecution-duration]')),
        color: rgb(getComputedStyle(name).color),
        surface: rgb(getComputedStyle(name).backgroundColor),
        rail: getComputedStyle(child).borderLeftWidth,
      };
    }),
  };
}
