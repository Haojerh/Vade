import { useLayoutEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { Icon } from '../components/ui/Icon';

type Section = 'explorer' | 'source' | 'agents';
export function RightSidebarTabs({value,onChange,onCollapse}:{value:Section;onChange:(value:Section)=>void;onCollapse:()=>void}) {
  const root=useRef<HTMLElement>(null),[left,setLeft]=useState(0);
  useLayoutEffect(()=>{
    const nav=root.current,selected=nav?.querySelector<HTMLElement>('[aria-selected="true"]'),icon=selected?.querySelector('svg');
    if(!nav||!selected||!icon)return;
    const measure=()=>{const host=nav.getBoundingClientRect(),box=icon.getBoundingClientRect();setLeft(box.left+box.width/2-host.left-12);};
    const observer=new ResizeObserver(measure);observer.observe(nav);observer.observe(selected);measure();return()=>observer.disconnect();
  },[value]);
  return <nav ref={root} className="right-tool-tabs github-tabs-nav" role="tablist" aria-label="Right sidebar sections"><span className="right-tool-indicator" aria-hidden="true" style={{transform:`translateX(${left}px)`}}/>{(['explorer','source','agents'] as const).map(section=>{const label=section==='source'?'Source Control':section==='agents'?'Agents':'Explorer';return <button type="button" key={section} className={`tab-btn ${value===section?'active':''}`} role="tab" aria-label={label} title={label} aria-selected={value===section} onClick={()=>onChange(section)}>{section==='agents'?<Bot size={16}/>:<Icon name={section==='source'?'git-branch':'folder'} size={15}/>}</button>;})}<button type="button" className="btn-icon right-tool-collapse" aria-label="Collapse tools sidebar" title="Collapse tools sidebar" onClick={onCollapse}><Icon name="chevrons-right" size={14}/></button></nav>;
}
