import type { Action } from "svelte/action";

type SwipeBackOptions = {
  enabled?: boolean;
  onBack: () => void;
  /** 提供時改為跟手模式：滑動中回報往右位移（px），放開時依距離或速度決定返回。 */
  onDrag?: (distance: number) => void;
  /** 跟手模式下滑動未達返回條件或被中斷時呼叫，讓畫面彈回原位。 */
  onCancel?: () => void;
};

const EDGE_WIDTH = 40;
const MIN_HORIZONTAL_DISTANCE = 72;
const MAX_VERTICAL_DISTANCE = 80;
const DRAG_START_DISTANCE = 10;
const COMMIT_WIDTH_RATIO = 0.35;
const FLICK_VELOCITY = 0.5;
const FLICK_MIN_DISTANCE = 32;
const VELOCITY_STALE_MS = 100;

export const swipeBack: Action<HTMLElement, SwipeBackOptions> = (
  node,
  initialOptions,
) => {
  let options = initialOptions;
  let start:
    { identifier: number; clientX: number; clientY: number } | undefined;
  let dragging = false;
  let last = { clientX: 0, time: 0 };
  let velocity = 0;
  const originalTouchAction = node.style.touchAction;

  function applyTouchAction() {
    node.style.touchAction =
      options.enabled === false ? originalTouchAction : "pan-y pinch-zoom";
  }

  function reset() {
    if (dragging) options.onCancel?.();
    start = undefined;
    dragging = false;
    velocity = 0;
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
    last = { clientX: touch.clientX, time: event.timeStamp };
    velocity = 0;
  }

  function handleTouchMove(event: TouchEvent) {
    const touch = findTouch(event.touches);
    if (!start || !touch) return;

    const horizontalDistance = touch.clientX - start.clientX;
    const verticalDistance = Math.abs(touch.clientY - start.clientY);
    const elapsed = event.timeStamp - last.time;
    if (elapsed > 0) velocity = (touch.clientX - last.clientX) / elapsed;
    last = { clientX: touch.clientX, time: event.timeStamp };

    if (
      !dragging &&
      horizontalDistance > DRAG_START_DISTANCE &&
      horizontalDistance > verticalDistance
    ) {
      dragging = Boolean(options.onDrag);
    }
    if (dragging) {
      event.preventDefault();
      options.onDrag?.(Math.max(0, horizontalDistance));
    } else if (
      horizontalDistance > DRAG_START_DISTANCE &&
      horizontalDistance > verticalDistance
    ) {
      event.preventDefault();
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    const touch = findTouch(event.changedTouches);
    if (!start || !touch) return;

    const horizontalDistance = touch.clientX - start.clientX;
    const verticalDistance = Math.abs(touch.clientY - start.clientY);
    // touchend 的座標可能比最後一次 touchmove 更遠；有差距時以最後一段計算放開速度。
    const sinceLastMove = event.timeStamp - last.time;
    const releaseVelocity =
      touch.clientX !== last.clientX && sinceLastMove > 0
        ? (touch.clientX - last.clientX) / sinceLastMove
        : sinceLastMove > VELOCITY_STALE_MS
          ? 0
          : velocity;
    const isBackSwipe = dragging
      ? horizontalDistance >= node.clientWidth * COMMIT_WIDTH_RATIO ||
        (releaseVelocity >= FLICK_VELOCITY &&
          horizontalDistance >= FLICK_MIN_DISTANCE)
      : horizontalDistance >= MIN_HORIZONTAL_DISTANCE &&
        verticalDistance <= MAX_VERTICAL_DISTANCE &&
        horizontalDistance > verticalDistance * 1.25;

    if (isBackSwipe) dragging = false;
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
