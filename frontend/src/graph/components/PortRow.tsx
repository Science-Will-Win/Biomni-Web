// ============================================
// Shared Port Row Component
// ============================================

import type { PortDef } from '../types';
import { PORT_COLORS } from '../port-types';
import { useGraphContext } from '../GraphContext';

interface PortRowProps {
  nodeId: string;
  ports: PortDef[];
  dir: 'in' | 'out';
}

export function PortRow({ nodeId, ports, dir }: PortRowProps) {
  const { onPortMouseDown } = useGraphContext();
  const filtered = ports.filter(p => p.dir === dir);
  if (filtered.length === 0) return null;

  return (
    <div className={`ng-ports-${dir}-row`} data-node-id={nodeId}>
      {filtered.map(port => (
        <div
          key={port.name}
          className={`ng-port ng-port-${dir}`}
          data-port-name={port.name}
          data-port-dir={dir}
          data-port-type={port.type}
          data-node-id={nodeId}
          style={{ '--port-color': PORT_COLORS[port.type] || PORT_COLORS.any } as React.CSSProperties}
          onMouseDown={(e) => {
            e.stopPropagation();
            onPortMouseDown?.(e, nodeId, port.name, dir, port.type);
          }}
        />
      ))}
    </div>
  );
}
