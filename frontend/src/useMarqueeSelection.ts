import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, label, [contenteditable='true'], [role='dialog'], .item-context-menu, .preview-backdrop, .drawer-backdrop";

type SelectableBounds = {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

type DragSelection = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  base: Set<string>;
  dragging: boolean;
  items: SelectableBounds[];
  frame?: number;
};

function sameSelection(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function useMarqueeSelection<
  TSurface extends HTMLElement,
  TItems extends HTMLElement,
>({
  surfaceRef,
  itemsRef,
  itemSelector,
  itemDataAttribute,
  enabled,
  selectedKeys,
  setSelectedKeys,
  onClear,
}: {
  surfaceRef: RefObject<TSurface | null>;
  itemsRef: RefObject<TItems | null>;
  itemSelector: string;
  itemDataAttribute: string;
  enabled: boolean;
  selectedKeys: Set<string>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  onClear: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSelection | undefined>(undefined);
  const selectedKeysRef = useRef(selectedKeys);
  const enabledRef = useRef(enabled);
  const clearRef = useRef(onClear);
  const suppressClickRef = useRef(false);
  const [active, setActive] = useState(false);
  selectedKeysRef.current = selectedKeys;
  enabledRef.current = enabled;
  clearRef.current = onClear;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const update = (drag: DragSelection) => {
      drag.frame = undefined;
      if (dragRef.current !== drag || !drag.dragging) return;
      const left = Math.min(drag.startX, drag.currentX);
      const top = Math.min(drag.startY, drag.currentY);
      const right = Math.max(drag.startX, drag.currentX);
      const bottom = Math.max(drag.startY, drag.currentY);
      const box = boxRef.current;
      if (box) {
        box.style.transform = `translate3d(${left}px, ${top}px, 0)`;
        box.style.width = `${right - left}px`;
        box.style.height = `${bottom - top}px`;
      }
      const hits = new Set(drag.base);
      for (const item of drag.items)
        if (
          item.left < right &&
          item.right > left &&
          item.top < bottom &&
          item.bottom > top
        )
          hits.add(item.key);
      setSelectedKeys((previous) =>
        sameSelection(previous, hits) ? previous : hits,
      );
    };

    const scheduleUpdate = (drag: DragSelection) => {
      if (drag.frame !== undefined) return;
      drag.frame = window.requestAnimationFrame(() => update(drag));
    };

    const pointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const items = itemsRef.current;
      if (
        !enabledRef.current ||
        !items ||
        event.pointerType === "touch" ||
        event.button !== 0 ||
        target?.closest(INTERACTIVE_SELECTOR)
      )
        return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        base:
          event.ctrlKey || event.metaKey
            ? new Set(selectedKeysRef.current)
            : new Set(),
        dragging: false,
        items: [],
      };
    };

    const pointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const items = itemsRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !items) return;
      if (
        !drag.dragging &&
        Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
      )
        return;
      if (!drag.dragging) {
        drag.dragging = true;
        drag.items = Array.from(
          items.querySelectorAll<HTMLElement>(itemSelector),
        ).flatMap((item) => {
          const key = item.getAttribute(itemDataAttribute);
          if (!key) return [];
          const bounds = item.getBoundingClientRect();
          return [{
            key,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.bottom,
          }];
        });
        setActive(true);
        items.classList.add("marquee-selecting");
        try {
          surface.setPointerCapture(event.pointerId);
        } catch {
          drag.dragging = false;
          items.classList.remove("marquee-selecting");
          setActive(false);
          return;
        }
      }
      event.preventDefault();
      drag.currentX = event.clientX;
      drag.currentY = event.clientY;
      scheduleUpdate(drag);
    };

    const finish = (event: PointerEvent, cancelled = false) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.frame !== undefined) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = undefined;
      }
      if (drag.dragging) {
        if (!cancelled) {
          drag.currentX = event.clientX;
          drag.currentY = event.clientY;
          update(drag);
        }
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      } else if (
        !cancelled &&
        !(event.target instanceof Element && event.target.closest(itemSelector))
      )
        clearRef.current();
      itemsRef.current?.classList.remove("marquee-selecting");
      setActive(false);
      dragRef.current = undefined;
      if (surface.hasPointerCapture(event.pointerId))
        surface.releasePointerCapture(event.pointerId);
    };

    const pointerUp = (event: PointerEvent) => finish(event);
    const pointerCancel = (event: PointerEvent) => finish(event, true);
    surface.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove, { passive: false });
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
    return () => {
      const drag = dragRef.current;
      if (drag?.frame !== undefined) window.cancelAnimationFrame(drag.frame);
      itemsRef.current?.classList.remove("marquee-selecting");
      surface.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerCancel);
    };
  }, [itemDataAttribute, itemSelector, itemsRef, setSelectedKeys, surfaceRef]);

  return { active, boxRef, suppressClickRef };
}
