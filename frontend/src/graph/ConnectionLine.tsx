// ============================================
// Bezier Connection Line (SVG)
// ============================================

import type { ConnectionData, NodeData } from './types';
import { getNodeDef } from './node-registry';

interface ConnectionLineProps {
  connection: ConnectionData;
  nodes: Map<string, NodeData>;
  containerEl?: HTMLElement | null;
  scale?: number;
  selected?: boolean;
  onClick?: (id: string) => void;
}

/**
 * Get port center position in graph coordinates.
 * Tries to read from DOM for accuracy, falls back to estimates.
 */
export function getPortCenter(
  node: NodeData,
  portName: string,
  dir: 'in' | 'out',
  containerEl?: HTMLElement | null,
): { x: number; y: number } {
  if (containerEl) {
    const portEl = containerEl.querySelector(
      `.ng-port[data-node-id="${node.id}"][data-port-name="${portName}"]`,
    ) as HTMLElement | null;
    if (portEl) {
      const nodeEl = containerEl.querySelector(
        `[data-node-id="${node.id}"].ng-node`,
      ) as HTMLElement | null;
      if (nodeEl) {
        // Get port center relative to node, then add node position
        const portRect = portEl.getBoundingClientRect();
        const nodeRect = nodeEl.getBoundingClientRect();
        const scale = nodeRect.width / (node.width || 180) || 1;
        return {
          x: node.x + (portRect.left - nodeRect.left + portRect.width / 2) / scale,
          y: node.y + (portRect.top - nodeRect.top + portRect.height / 2) / scale,
        };
      }
    }
  }

  // Fallback: estimate based on node dimensions
  const nodeWidth = node.width || 180;
  const def = getNodeDef(node.type);
  const ports = def?.ports ?? [];
  const sameDirPorts = ports.filter(p => p.dir === dir);
  const idx = sameDirPorts.findIndex(p => p.name === portName);
  const count = sameDirPorts.length || 1;
  const portX = nodeWidth * (idx + 1) / (count + 1);
  const portY = dir === 'in' ? 0 : 80;

  return { x: node.x + portX, y: node.y + portY };
}

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dy = Math.abs(y2 - y1);
  const cpOffset = Math.max(40, dy * 0.4);
  return `M ${x1} ${y1} C ${x1} ${y1 + cpOffset}, ${x2} ${y2 - cpOffset}, ${x2} ${y2}`;
}

export function ConnectionLine({
  connection,
  nodes,
  containerEl,
  selected,
  onClick,
}: ConnectionLineProps) {
  const fromNode = nodes.get(connection.from);
  const toNode = nodes.get(connection.to);
  if (!fromNode || !toNode) return null;

  const from = getPortCenter(fromNode, connection.fromPort, 'out', containerEl);
  const to = getPortCenter(toNode, connection.toPort, 'in', containerEl);

  const pathD = bezierPath(from.x, from.y, to.x, to.y);
  const isRef = connection.type === 'ref';

  // Determine port type for connection color
  const fromDef = getNodeDef(fromNode.type);
  const fromPortDef = fromDef?.ports?.find(p => p.name === connection.fromPort && p.dir === 'out');
  const portTypeClass = fromPortDef?.type ? `ng-conn-type-${fromPortDef.type}` : '';

  return (
    <g className={`ng-connection ${portTypeClass} ${selected ? 'ng-connection-selected' : ''}`}>
      {/* Invisible wider hit area — left-click to select */}
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onClick={(e) => { e.stopPropagation(); onClick?.(connection.id); }}
      />
      <path
        d={pathD}
        fill="none"
        className={`ng-conn-stroke ${isRef ? 'ng-conn-ref' : 'ng-conn-flow'}`}
        strokeWidth={isRef ? 1.5 : 2}
        strokeDasharray={isRef ? '6 4' : undefined}
        style={{ pointerEvents: 'none' }}
      />
    </g>
  );
}

/** Pending connection temp line (drawn while dragging from a port) */
export function PendingConnectionLine({
  x1, y1, x2, y2, isRef,
}: {
  x1: number; y1: number; x2: number; y2: number; isRef: boolean;
}) {
  const pathD = bezierPath(x1, y1, x2, y2);
  return (
    <path
      d={pathD}
      fill="none"
      stroke={isRef ? '#ab47bc' : '#3b82f6'}
      strokeWidth={2}
      strokeDasharray={isRef ? '6 4' : undefined}
      opacity={0.7}
      style={{ pointerEvents: 'none' }}
    />
  );
}
