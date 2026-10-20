export interface FloatingPlayerPoint { x: number; y: number; }

/** Preserve the drag offset while bringing the rendered box inside the window. */
export function clampFloatingPlayerPosition(
  offset: FloatingPlayerPoint,
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): FloatingPlayerPoint {
  const left = Math.max(margin, Math.min(rect.left, viewport.width - rect.width - margin));
  const top = Math.max(margin, Math.min(rect.top, viewport.height - rect.height - margin));
  return { x: offset.x + left - rect.left, y: offset.y + top - rect.top };
}
