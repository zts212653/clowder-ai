import { type ButtonHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode } from 'react';
export function WorldRailFrame({
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLElement> & { readonly children: ReactNode }) {
  return (
    <nav {...props} className={`cafe-world-rail ${className}`}>
      {children}
    </nav>
  );
}
export function HeaderFrame({
  children,
  className = '',
  as: Element = 'header',
  ...props
}: HTMLAttributes<HTMLElement> & { readonly children: ReactNode; readonly as?: 'header' | 'div' }) {
  return (
    <Element {...props} className={`cafe-header ${className}`}>
      {children}
    </Element>
  );
}

/** Home and Collective share this visual surface; each wrapper owns its controls and submission. */
export function ComposerFrame({
  children,
  className = '',
  active = true,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly children: ReactNode; readonly active?: boolean }) {
  return (
    <div {...props} className={`${active ? 'cafe-composer-surface ' : ''}${className}`}>
      {children}
    </div>
  );
}

/** A visual button only; the application keeps menus, submission and authority. */
export const ComposerControl = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { readonly active?: boolean }
>(function ComposerControl({ className = '', active = true, type = 'button', ...props }, ref) {
  return (
    <button {...props} ref={ref} type={type} className={`${active ? 'cafe-composer-control ' : ''}${className}`} />
  );
});
