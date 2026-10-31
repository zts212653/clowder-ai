import { type RefObject, useLayoutEffect, useState } from 'react';

const RECIPIENT_NAME_MIN_WIDTH = 20;

interface CompactRoutingLayout {
  mobile: boolean;
  minimumWidth: number;
  showName: boolean;
}

interface CompactRoutingLayoutRefs {
  button: RefObject<HTMLButtonElement>;
  sendToLabel: RefObject<HTMLSpanElement>;
  avatarGroup: RefObject<HTMLSpanElement>;
  chevron: RefObject<HTMLSpanElement>;
}

interface UseCompactRoutingLayoutOptions extends CompactRoutingLayoutRefs {
  active: boolean;
  hasChevron: boolean;
  visibleRecipientCount: number;
}

const DESKTOP_LAYOUT: CompactRoutingLayout = { mobile: false, minimumWidth: 0, showName: true };

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameLayout(left: CompactRoutingLayout, right: CompactRoutingLayout): boolean {
  return left.mobile === right.mobile && left.minimumWidth === right.minimumWidth && left.showName === right.showName;
}

export function useCompactRoutingLayout({
  active,
  hasChevron,
  visibleRecipientCount,
  button,
  sendToLabel,
  avatarGroup,
  chevron,
}: UseCompactRoutingLayoutOptions): CompactRoutingLayout {
  const [layout, setLayout] = useState<CompactRoutingLayout>(DESKTOP_LAYOUT);

  useLayoutEffect(() => {
    if (!active) return;
    const buttonElement = button.current;
    const labelElement = sendToLabel.current;
    if (!buttonElement) return;
    if (!labelElement) return;

    const measure = () => {
      if (window.innerWidth > 639) {
        setLayout((previous) => (sameLayout(previous, DESKTOP_LAYOUT) ? previous : DESKTOP_LAYOUT));
        return;
      }

      const visibleAvatarGroup = visibleRecipientCount > 0 ? avatarGroup.current : null;
      const visibleChevron = hasChevron ? chevron.current : null;
      const mandatory = [labelElement, visibleAvatarGroup, visibleChevron].filter(
        (element): element is HTMLElement => element !== null,
      );
      const buttonStyle = getComputedStyle(buttonElement);
      const gap = cssPixelValue(buttonStyle.columnGap);
      const padding = cssPixelValue(buttonStyle.paddingLeft) + cssPixelValue(buttonStyle.paddingRight);
      const mandatoryWidth = mandatory.reduce((total, element) => {
        const style = getComputedStyle(element);
        const margins = cssPixelValue(style.marginLeft) + cssPixelValue(style.marginRight);
        return total + element.getBoundingClientRect().width + margins;
      }, padding);
      const minimumWidth = Math.ceil((mandatoryWidth + gap * Math.max(0, mandatory.length - 1)) * 100) / 100;
      const showName =
        visibleRecipientCount > 0 && buttonElement.clientWidth - minimumWidth - gap >= RECIPIENT_NAME_MIN_WIDTH;
      const next = { mobile: true, minimumWidth, showName };
      setLayout((previous) => (sameLayout(previous, next) ? previous : next));
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(buttonElement);
    observer?.observe(labelElement);
    if (avatarGroup.current) observer?.observe(avatarGroup.current);
    if (chevron.current) observer?.observe(chevron.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, avatarGroup, button, chevron, hasChevron, sendToLabel, visibleRecipientCount]);

  return layout;
}
