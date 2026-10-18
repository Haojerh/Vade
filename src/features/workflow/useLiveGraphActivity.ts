import { useEffect, useRef, useState } from 'react';
import type { Edge, Node, OrchestrationMessage, ToolActivity } from '../../../shared/contracts';

export interface LiveTool extends ToolActivity { nodeId: string; expiresAt: number }
export interface LivePacket extends OrchestrationMessage { expiresAt: number }

/** Establish a baseline on connect; animate only newly observed stable event IDs. */
export function useLiveGraphActivity(scope: string, nodes: Node[], edges: Edge[], enabled: boolean) {
  const seen = useRef(new Set<string>());
  const boundScope = useRef<string | null>(null);
  const initializedSources = useRef(new Set<string>());
  const [tools, setTools] = useState<LiveTool[]>([]);
  const [packets, setPackets] = useState<LivePacket[]>([]);
  useEffect(() => {
    const first = boundScope.current !== scope;
    if (first) {
      boundScope.current = scope;
      seen.current.clear();
      initializedSources.current.clear();
      setTools([]);
      setPackets([]);
    }
    const now = Date.now();
    const newTools: LiveTool[] = [];
    const newPackets: LivePacket[] = [];
    for (const node of nodes) {
      if (node.stale || node.toolActivity?.meta.stale) continue;
      const source = `node:${node.id}`;
      const initialized = initializedSources.current.has(source);
      if (node.toolActivity?.data) initializedSources.current.add(source);
      for (const item of node.toolActivity?.data ?? []) {
        const known = seen.current.has(item.id);
        seen.current.add(item.id);
        if (!first && initialized && !known && enabled && (!item.at || now - Date.parse(item.at) < 30000)) {
          newTools.push({ ...item, nodeId: node.id, expiresAt: now + 4500 });
        }
      }
    }
    const mailInitialized = initializedSources.current.has('mail');
    if (edges.length) initializedSources.current.add('mail');
    for (const edge of edges) for (const message of edge.messages ?? []) {
      const known = seen.current.has(message.id);
      seen.current.add(message.id);
      if (!first && mailInitialized && !known && now - Date.parse(message.at) < 30000) newPackets.push({ ...message, expiresAt: now + 1600 });
    }
    if (seen.current.size > 10000) seen.current = new Set([...seen.current].slice(-5000));
    if (newTools.length) setTools((previous) => [...previous, ...newTools].slice(-200));
    if (!enabled) setTools([]);
    if (newPackets.length) setPackets((previous) => [...previous, ...newPackets].slice(-100));
  }, [scope, nodes, edges, enabled]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTools((items) => items.some((item) => item.expiresAt <= now) ? items.filter((item) => item.expiresAt > now) : items);
      setPackets((items) => items.some((item) => item.expiresAt <= now) ? items.filter((item) => item.expiresAt > now) : items);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);
  return { tools, packets };
}
