import { Icon } from '../../../components/ui/Icon';
import { MIN_WORKFLOW_ZOOM, MAX_WORKFLOW_ZOOM } from './workflowZoom';

export function WorkflowZoomControls({ zoom, onChange }: { zoom: number; onChange: (value: number) => void }) {
  return <div className="workflow-zoom-controls" role="group" aria-label="Topology zoom" title="Ctrl + mouse wheel or touchpad pinch to zoom; scroll or drag the background to pan">
    <button type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= MIN_WORKFLOW_ZOOM} onClick={() => onChange(zoom - .1)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg></button>
    <button type="button" className="workflow-zoom-value" aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100 percent`} title="Reset zoom to 100%" onClick={() => onChange(1)}>{Math.round(zoom * 100)}<span>%</span></button>
    <button type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= MAX_WORKFLOW_ZOOM} onClick={() => onChange(zoom + .1)}><Icon name="plus" size={14} /></button>
  </div>;
}
