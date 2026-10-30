export const MIN_WORKFLOW_ZOOM = 0.4;
export const MAX_WORKFLOW_ZOOM = 2;

export function clampWorkflowZoom(value: number): number {
  return Math.min(MAX_WORKFLOW_ZOOM, Math.max(MIN_WORKFLOW_ZOOM, value));
}

export function zoomScrollOffset(scroll: number, pointer: number, before: number, after: number): number {
  return Math.max(0, (scroll + pointer) / before * after - pointer);
}

export function workflowBox(rect: { left: number; top: number; width: number; height: number }, origin: { left: number; top: number }, zoom: number) {
  return { x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom,
    width: rect.width / zoom, height: rect.height / zoom };
}
