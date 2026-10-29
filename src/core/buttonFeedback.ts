import { soundFx } from './soundFx';

// Document-level handling includes buttons inside portals and supports keyboard clicks.
export function installButtonFeedback() {
  const rings = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const handleClick = (event: MouseEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>('button, [role="button"]');
    if (!button || button.matches(':disabled, [aria-disabled="true"]') || button.closest('[data-ui-feedback="off"], [inert]')) return;
    soundFx.playClick();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ring = document.createElement('span');
    ring.className = 'ui-click-ring';
    ring.setAttribute('aria-hidden', 'true');
    Object.assign(ring.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: getComputedStyle(button).borderRadius});
    document.body.appendChild(ring);
    rings.set(ring, setTimeout(() => {ring.remove(); rings.delete(ring);}, 320));
  };
  document.addEventListener('click', handleClick);
  return () => {
    document.removeEventListener('click', handleClick);
    rings.forEach((timer, ring) => {clearTimeout(timer); ring.remove();});
    rings.clear();
  };
}
