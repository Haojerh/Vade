import React from 'react';

/** One observed delivery, using a single moving group for bead and halo. */
export function DeliveryPacket({ path, reverse = false, reducedMotion = false, endX, endY, tone = 'blue' }: {
  path: string; reverse?: boolean; reducedMotion?: boolean; endX: number; endY: number; tone?: 'blue' | 'green';
}) {
  return <g className={`delivery-packet delivery-packet-${tone}`}>
    <circle cx={reducedMotion ? endX : 0} cy={reducedMotion ? endY : 0} r={tone === 'green' ? 7 : 5} className="edge-delivery-halo" />
    <circle cx={reducedMotion ? endX : 0} cy={reducedMotion ? endY : 0} r={tone === 'green' ? 3.5 : 3} className="edge-delivery-bead" />
    {!reducedMotion && <animateMotion path={path} dur="1.4s" repeatCount="1" keyPoints={reverse ? '1;0' : '0;1'}
      keyTimes="0;1" calcMode="linear" fill="freeze" rotate="auto" />}
    {!reducedMotion && <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.05;0.9;1" dur="1.4s" repeatCount="1" fill="freeze" />}
  </g>;
}
