/** Quote gutters share the paper's coordinate frame, including sibling layout changes without a resize. */
export function observeWorkspaceQuoteLayout(paper: HTMLElement, parent: HTMLElement, measure: () => void) {
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
  resize?.observe(paper);
  resize?.observe(parent);
  const flow = new MutationObserver(measure);
  flow.observe(parent, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  paper.addEventListener('scroll', measure);
  window.addEventListener('resize', measure);
  return () => {
    resize?.disconnect();
    flow.disconnect();
    paper.removeEventListener('scroll', measure);
    window.removeEventListener('resize', measure);
  };
}
