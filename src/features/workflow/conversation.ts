import type { ConversationMessage } from '../../../shared/contracts';

export function latestAgentMessage(messages: ConversationMessage[]): ConversationMessage | null {
  return [...messages].reverse().find((message) => message.role === 'agent' && message.text.trim()) ?? null;
}
