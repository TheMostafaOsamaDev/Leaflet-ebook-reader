import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export interface LongPressBindings {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => void;
}

export interface UseLongPressOptions {
  /** Skip the long press entirely for a mouse pointer. Set it where the
   *  element's primary click action matters more than its long-press
   *  one and right-click already covers the desktop case — otherwise a
   *  deliberate slow click fires the long press instead of the click.
   *  Defaults to false, so touch-first consumers are unaffected. */
  ignoreMouse?: boolean;
}

export interface UseLongPressResult {
  bind: LongPressBindings;
  /** Returns true exactly once after a long-press fired — call from your
      click handler to swallow the trailing synthetic tap so the user
      doesn't navigate into the book they just opened a menu for. */
  consumeLongPress: () => boolean;
}

/**
 * Long-press handler that mirrors right-click on touch devices. The press
 * is cancelled if the pointer moves more than MOVE_TOLERANCE_PX so that
 * vertical scrolls through a list don't trigger the menu.
 */
export function useLongPress(
  handler: (x: number, y: number) => void,
  options: UseLongPressOptions = {},
): UseLongPressResult {
  // Read off the option rather than depending on `options`: the caller
  // passes a fresh object literal every render, and depending on it
  // would give every binding a new identity each time.
  const ignoreMouse = options.ignoreMouse === true;
  const timerRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  const firedRef = useRef(false);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Mouse: opt-out entirely, else left-button only. Touch/pen
      // always pass through.
      if (e.pointerType === "mouse") {
        if (ignoreMouse) return;
        if (e.button !== 0) return;
      }
      firedRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      cancel();
      const x = e.clientX;
      const y = e.clientY;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        if (typeof navigator.vibrate === "function") navigator.vibrate(15);
        handlerRef.current(x, y);
      }, LONG_PRESS_MS);
    },
    [cancel, ignoreMouse],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (timerRef.current === null) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      if (dx * dx + dy * dy > MOVE_TOLERANCE_PX * MOVE_TOLERANCE_PX) cancel();
    },
    [cancel],
  );

  const consumeLongPress = useCallback(() => {
    if (firedRef.current) {
      firedRef.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
    },
    consumeLongPress,
  };
}
