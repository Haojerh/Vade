export function AgentChatMetadata({ model, effort }: { model?: string | null; effort?: string | null }) {
  const observedModel = model && model !== 'unknown' ? model : undefined;
  const observedEffort = effort && effort !== 'unknown' ? effort : undefined;
  if (!observedModel && !observedEffort) return null;
  return <div className="agent-chat-controls agent-chat-metadata" aria-label="Observed model and effort">
    {observedModel && <span className="agent-chat-model" title={`Model: ${observedModel}`}>{observedModel}</span>}
    {observedEffort && <span className="text-muted" title={`Effort: ${observedEffort}`}>{observedEffort}</span>}
  </div>;
}
