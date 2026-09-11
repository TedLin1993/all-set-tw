import type { Action } from "svelte/action";

type SwipeBackOptions = {
  enabled?: boolean;
  onBack: () => void;
};

const EDGE_WIDTH = 40;
const MIN_HORIZONTAL_DISTANCE = 72;
const MAX_VERTICAL_DISTANCE = 80;

export const swipeBack: Action<HTMLElement, SwipeBackOptions> = (
  node,
  initialOptions,
) => {
  let options = initialOptions;
  let start:
    { identifier: number; clientX: number; clientY: number } | undefined;
  const originalTouchAction = node.style.touchAction;

  function applyTouchAction() {
    node.style.touchAction =
      options.enabled === false ? originalTouchAction : "pan-y pinch-zoom";
  }

  function reset() {
    start = undefined;
  }

  function findTouch(touches: TouchList) {
    if (!start) return;
    return Array.from(touches).find(
      (touch) => touch.identifier === start?.identifier,
    );
  }

  function handleTouchStart(event: TouchEvent) {
    if (options.enabled === false || event.touches.length !== 1) {
      reset();
      return;
    }

    const touch = event.touches[0];
    if (!touch || touch.clientX > EDGE_WIDTH) {
      reset();
      return;
    }

    start = {
      identifier: touch.identifier,
      clientX: touch.clientX,
      clientY: touch.clientY,
    };
  }

  function handleTouchMove(event: TouchEvent) {
    const touch = findTouch(event.touches);
    if (!start || !touch) return;

    const horizontalDistance = touch.clientX - start.clientX;
    const verticalDistance = Math.abs(touch.clientY - start.clientY);
    if (horizontalDistance > 10 && horizontalDistance > verticalDistance) {
      event.preventDefault();
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    const touch = findTouch(event.changedTouches);
    if (!start || !touch) return;

    const horizontalDistance = touch.clientX - start.clientX;
    const verticalDistance = Math.abs(touch.clientY - start.clientY);
    const isBackSwipe =
      horizontalDistance >= MIN_HORIZONTAL_DISTANCE &&
      verticalDistance <= MAX_VERTICAL_DISTANCE &&
      horizontalDistance > verticalDistance * 1.25;

    reset();
    if (isBackSwipe) options.onBack();
  }

  applyTouchAction();
  node.addEventListener("touchstart", handleTouchStart, { passive: true });
  node.addEventListener("touchmove", handleTouchMove, { passive: false });
  node.addEventListener("touchend", handleTouchEnd, { passive: true });
  node.addEventListener("touchcancel", reset, { passive: true });

  return {
    update(nextOptions) {
      options = nextOptions;
      reset();
      applyTouchAction();
    },
    destroy() {
      node.style.touchAction = originalTouchAction;
      node.removeEventListener("touchstart", handleTouchStart);
      node.removeEventListener("touchmove", handleTouchMove);
      node.removeEventListener("touchend", handleTouchEnd);
      node.removeEventListener("touchcancel", reset);
    },
  };
};
