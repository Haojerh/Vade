import { useState, useEffect, useRef, useCallback } from 'react';
import type { NodeDetails } from '../../../shared/contracts';
import { fetchNodeDetails, subscribeConversationEvents } from '../../api/client';

export interface UseNodeDetailsLoaderProps {
  selectedProjectId: string | null;
  selectedNodeId: string | null;
  selectedRunId: string | null;
}

export interface UseNodeDetailsLoaderReturn {
  nodeDetails: NodeDetails | null;
  setNodeDetails: React.Dispatch<React.SetStateAction<NodeDetails | null>>;
  nodeDetailsLoading: boolean;
  setNodeDetailsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  nodeDetailsError: string | null;
  setNodeDetailsError: React.Dispatch<React.SetStateAction<string | null>>;
  nodeAbortRef: React.MutableRefObject<AbortController | null>;
  nodeGeneration: React.MutableRefObject<number>;
  loadNodeDetails: () => Promise<void>;
  refreshNodeDetails: () => void;
  setConversationVisible: (visible: boolean) => void;
}

export function useNodeDetailsLoader({
  selectedProjectId,
  selectedNodeId,
  selectedRunId,
}: UseNodeDetailsLoaderProps): UseNodeDetailsLoaderReturn {
  const [nodeDetails, setNodeDetails] = useState<NodeDetails | null>(null);
  const [nodeDetailsLoading, setNodeDetailsLoading] = useState<boolean>(false);
  const [nodeDetailsError, setNodeDetailsError] = useState<string | null>(null);
  const [conversationVisible, setConversationVisible] = useState(true);
  const streamCursor = useRef<{ key: string; current: string | null }>({ key: '', current: null });

  const nodeGeneration = useRef<number>(0);
  const nodeAbortRef = useRef<AbortController | null>(null);

  const loadNodeDetails = useCallback(async () => {
    if (!selectedProjectId || !selectedNodeId) {
      setNodeDetails(null);
      return;
    }

    const currentGen = ++nodeGeneration.current;

    if (nodeAbortRef.current) {
      nodeAbortRef.current.abort();
    }
    const abort = new AbortController();
    nodeAbortRef.current = abort;

    setNodeDetails((prev) => (prev && prev.node.id === selectedNodeId ? prev : null));
    setNodeDetailsLoading(true);
    setNodeDetailsError(null);

    try {
      const details = await fetchNodeDetails(
        selectedProjectId,
        selectedNodeId,
        {
          runId: selectedRunId,
          limit: 20,
          direction: 'older',
        },
        abort.signal,
      );

      if (abort.signal.aborted || currentGen !== nodeGeneration.current) return;

      setNodeDetails(details);
    } catch (err: any) {
      if (!abort.signal.aborted && currentGen === nodeGeneration.current) {
        setNodeDetailsError(err.message || 'Failed to load node details');
      }
    } finally {
      if (!abort.signal.aborted && currentGen === nodeGeneration.current) {
        setNodeDetailsLoading(false);
      }
    }
  }, [selectedProjectId, selectedNodeId, selectedRunId]);

  useEffect(() => {
    if (selectedNodeId) {
      loadNodeDetails();
    } else {
      setNodeDetails(null);
    }
    return () => {
      if (nodeAbortRef.current) {
        nodeAbortRef.current.abort();
      }
    };
  }, [loadNodeDetails, selectedNodeId]);

  const streamKind = nodeDetails?.node.id === selectedNodeId && (nodeDetails.session?.chat !== false || nodeDetails.session.history) ? nodeDetails.node.kind : null;
  const streamIdentity = nodeDetails?.conversation.data?.sourceIdentity;
  useEffect(() => {
    const key = JSON.stringify([selectedProjectId, selectedNodeId, selectedRunId, streamIdentity]);
    if (streamCursor.current.key !== key) streamCursor.current = { key, current: null };
    if (!conversationVisible) return;
    if (!selectedProjectId || !selectedNodeId || !streamKind || !['agent', 'orchestrator'].includes(streamKind)) return;
    return subscribeConversationEvents(selectedProjectId, selectedNodeId, selectedRunId, (conversation) => {
        if (conversation.data && conversation.data.sourceIdentity !== streamIdentity) { void loadNodeDetails(); return; }
        setNodeDetails(current => {
          if (current?.node.id !== selectedNodeId) return current;
          const previous = current.conversation.data;
          if (!previous || !conversation.data) return { ...current, conversation: { ...conversation, data: previous } };
          const messages = new Map(previous.messages.map(message => [message.id, message]));
          for (const message of conversation.data.messages) messages.set(message.id, message);
          // Keep the older-history cursor; streamed cursors are forward-only and belong to the SSE client.
          return { ...current, conversation: { ...conversation, data: { ...previous, rounds:conversation.data.rounds??previous.rounds, revision: conversation.data.revision ?? previous.revision, messages: [...messages.values()] } } };
        });
        setNodeDetailsError(null);
      }, (connected) => {
        setNodeDetailsError(connected ? null : 'Live conversation disconnected. Reconnecting…');
      }, () => { void loadNodeDetails(); }, streamCursor.current, update=>{
        setNodeDetails(current=>{
          if(current?.node.id!==selectedNodeId)return current;
          const prior=Date.parse(current.node.observedAt??'');if(Number.isFinite(prior)&&prior>Date.parse(update.observedAt))return current;
          const agentStatus=update.agentStatus;
          return {...current,node:{...current.node,agentStatus,liveness:update.liveness,observedAt:update.observedAt,state:agentStatus.meta.availability==='ready'&&agentStatus.data?agentStatus.data.state:'unknown',lastActivityAt:agentStatus.meta.observedAt,stale:agentStatus.meta.stale}};
        });
      });
  }, [selectedProjectId, selectedNodeId, selectedRunId, streamKind, streamIdentity, loadNodeDetails, conversationVisible]);

  const refreshNodeDetails = useCallback(() => {
    loadNodeDetails();
  }, [loadNodeDetails]);

  return {
    nodeDetails,
    setNodeDetails,
    nodeDetailsLoading,
    setNodeDetailsLoading,
    nodeDetailsError,
    setNodeDetailsError,
    nodeAbortRef,
    nodeGeneration,
    loadNodeDetails,
    refreshNodeDetails,
    setConversationVisible,
  };
}
