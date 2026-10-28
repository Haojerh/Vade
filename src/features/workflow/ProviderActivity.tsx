import type { Node,ConversationRound } from '../../../shared/contracts';
import { AgentWorkTime } from './AgentWorkTime';

export function ProviderActivity({ node,settledRounds=[] }: { node: Node;settledRounds?:ConversationRound[] }) {
  const section = node.providerActivity;
  const errors = section?.data?.filter(item => item.kind === 'error' && !(node.state === 'interrupted' && /^(?:aborted|request aborted|the operation was aborted\.?)$/i.test(item.message?.trim() ?? ''))) ?? [];
  // Native working status is the broad fallback, independent of transcript
  // flushes and provider support for live reasoning records (as in Orca).
  const working = node.state === 'working' && node.liveness === 'live' && !node.stale;
  const reasoning = working && !section?.meta.stale && section?.data?.some(item => item.kind === 'reasoning' && item.state === 'active');
  const time=node.agentStatus?.data?.workTime;
  const foldedTime=!working&&time&&settledRounds.some(round=>Date.parse(round.endedAt)>=Date.parse(time.startedAt));
  if (!errors.length && !working && !node.agentStatus?.data?.workTime) return null;
  return <div className="provider-activity" aria-label="Provider activity">
    {errors.map(item => <div key={item.id} className="panel-alert alert-error" role="alert"><strong>Provider error</strong><p>{item.message}</p></div>)}
    <div className="provider-working-line">{working && <div className="provider-reasoning" role="status" aria-label={reasoning ? 'Reasoning' : 'Agent working'}><span className="provider-reasoning-dots" aria-hidden="true"><i /><i /><i /></span></div>}{!foldedTime&&<AgentWorkTime node={node}/>}</div>
  </div>;
}
