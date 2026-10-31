export async function editorLayout(frame) {
  await frame.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return frame.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.ProseMirror p')].find((node) => node.textContent.trim());
    if (!paragraph) return { visible: false, reason: 'no rendered text' };
    const boxes = [];
    let node = paragraph;
    while (node && boxes.length < 9) {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      boxes.push({
        tag: node.tagName,
        className: node.className,
        text: node === paragraph ? node.textContent : undefined,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        position: style.position,
        transform: style.transform,
        zoom: style.zoom,
        overflow: style.overflow,
        padding: style.padding,
        margin: style.margin,
        color: style.color,
        opacity: style.opacity,
        visibility: style.visibility,
        font: style.font,
        clipPath: style.clipPath,
        contentVisibility: style.contentVisibility,
      });
      node = node.parentElement;
    }
    const box = boxes[0];
    const textStyles = [...paragraph.querySelectorAll('*')].map((node) => ({
      tag: node.tagName,
      text: node.textContent,
      color: getComputedStyle(node).color,
      opacity: getComputedStyle(node).opacity,
      visibility: getComputedStyle(node).visibility,
      font: getComputedStyle(node).font,
    }));
    return {
      visible: box.x < innerWidth && box.x + box.width > 0 && box.y < innerHeight && box.y + box.height > 0,
      fonts: document.fonts.status,
      viewport: { width: innerWidth, height: innerHeight },
      boxes,
      textStyles,
    };
  });
}
