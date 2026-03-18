// ============================================
// Graph Canvas — main graph rendering component
// 2C-1: static render, 2C-2: viewport, 2C-3: connections
// ============================================

import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import type { NodeData, ConnectionData, ConnectionType } from './types';
import { getNodeDef } from './node-registry';
import { ConnectionLine, PendingConnectionLine, getPortCenter } from './ConnectionLine';
import { PortTypes } from './port-types';
import { GraphProvider } from './GraphContext';
import { CreateNodeMenu } from './components/CreateNodeMenu';
import { NodeDetailModal } from './components/NodeDetailModal';
import { useAppContext } from '@/context/AppContext';
import type { useGraphEngine } from './useGraphEngine';

type GraphEngine = ReturnType<typeof useGraphEngine>;

interface GraphCanvasProps {
  engine: GraphEngine;
  visible?: boolean;
  skipInitialLayout?: boolean;
}

interface PendingConn {
  fromNodeId: string;
  fromPort: string;
  fromDir: 'in' | 'out';
  fromType: string;
  connType: ConnectionType;
  startX: number;
  startY: number;
}

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

function GraphNode({
  node,
  selected,
  multiSelected,
  connectedPorts,
  onTitleChange,
  onPortValueChange,
  onMouseDown,
  onResizeStart,
  onDoubleClick,
}: {
  node: NodeData;
  selected: boolean;
  multiSelected: boolean;
  connectedPorts?: Set<string>;
  onTitleChange: (id: string, title: string) => void;
  onPortValueChange: (nodeId: string, portName: string, value: unknown) => void;
  onMouseDown: (e: React.MouseEvent, nodeId: string) => void;
  onResizeStart: (e: React.MouseEvent, nodeId: string, handle: string) => void;
  onDoubleClick: (e: React.MouseEvent, nodeId: string) => void;
}) {
  const def = getNodeDef(node.type);
  if (!def) return null;
  const Component = def.component;

  return (
    <div
      className={`ng-node ng-status-${node.status} ng-cat-${(def.category || 'General').toLowerCase().replace(/\s+/g, '-')}${selected ? ' ng-node-selected' : ''}${multiSelected ? ' ng-node-selected' : ''}`}
      data-node-id={node.id}
      data-node-type={node.type}
      style={{ position: 'absolute', left: node.x, top: node.y, width: node.width || def.minWidth || 180, minHeight: node.height }}
      onMouseDown={(e) => onMouseDown(e, node.id)}
      onDoubleClick={(e) => onDoubleClick(e, node.id)}
    >
      <Component node={node} connectedPorts={connectedPorts} onTitleChange={onTitleChange} onPortValueChange={onPortValueChange} />
      {(selected || multiSelected) && RESIZE_HANDLES.map(h => (
        <div key={h} className={`ng-resize-handle ng-resize-${h}`}
          onMouseDown={(e) => { e.stopPropagation(); onResizeStart(e, node.id, h); }} />
      ))}
    </div>
  );
}

export function GraphCanvas({ engine, visible = true, skipInitialLayout = false }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { dispatch: appDispatch } = useAppContext();
  const { state, setNodeTitle, setNodeDescription, setPortValue, setViewport, selectNode, toggleSelectNode, setSelectedNodes, selectConnection, addNode, updateNode, addConnection, removeConnection, removeNode, removeNodes, pushUndo, undo, redo, relayoutVertical } = engine;

  // Node detail modal state
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);

  const dragRef = useRef<{
    type: 'pan' | 'node' | 'marquee';
    nodeId?: string;
    startX: number; startY: number;
    startPanX: number; startPanY: number;
    startNodeX: number; startNodeY: number;
    groupOffsets?: Map<string, { dx: number; dy: number }>;
  } | null>(null);

  // Marquee selection
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Clipboard
  const clipboardRef = useRef<{ nodes: NodeData[]; connections: ConnectionData[] } | null>(null);

  const pendingConnRef = useRef<PendingConn | null>(null);
  const [pendingLine, setPendingLine] = useState<{ x1: number; y1: number; x2: number; y2: number; isRef: boolean } | null>(null);

  // Smart right-click: track if mouse moved >5px (pan) or not (context menu)
  const rightClickRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  // Node resize state
  const resizeRef = useRef<{
    nodeId: string;
    handle: string;
    startX: number; startY: number;
    startNodeX: number; startNodeY: number;
    startW: number; startH: number;
  } | null>(null);

  // Create Node menu state
  const [createMenu, setCreateMenu] = useState<{ screenX: number; screenY: number; graphX: number; graphY: number } | null>(null);
  let nextNodeIdRef = useRef(100);

  // Layout ready: hide graph until measurement + relayout completes
  const [layoutReady, setLayoutReady] = useState(false);
  // Render tick: force re-render during drag so connections follow nodes
  const [renderTick, setRenderTick] = useState(0);
  const rafRef = useRef(0);

  const nodesArray = Array.from(state.nodes.values());
  const connectionsArray = Array.from(state.connections.values());
  // fitToView on initial render
  const hasFitted = useRef(false);
  useEffect(() => {
    if (nodesArray.length > 0 && !hasFitted.current && containerRef.current) {
      requestAnimationFrame(() => {
        if (containerRef.current && fitToView(engine, containerRef.current)) {
          hasFitted.current = true;
        }
      });
    }
  }, [nodesArray.length, engine]);
  useEffect(() => { if (nodesArray.length === 0) hasFitted.current = false; }, [nodesArray.length]);

  // Measure actual node heights from DOM and relayout for edge-to-edge equal spacing
  const measuredRef = useRef(false);
  const measureRetryRef = useRef(0);
  const initialFitDone = useRef(skipInitialLayout);
  // When skipInitialLayout becomes true (e.g., localStorage restore), mark layout as done
  useEffect(() => {
    if (skipInitialLayout) {
      initialFitDone.current = true;
      setLayoutReady(true);
    }
  }, [skipInitialLayout]);
  useEffect(() => {
    if (nodesArray.length === 0) { measuredRef.current = false; measureRetryRef.current = 0; initialFitDone.current = false; setLayoutReady(false); return; }
    if (measuredRef.current) return;
    // Delay to allow DOM to render (retry up to 5 times if container not ready)
    const delay = measureRetryRef.current > 0 ? 100 : 50;
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) {
        // Container not ready — retry
        if (measureRetryRef.current < 5) {
          measureRetryRef.current++;
          setLayoutReady(prev => prev); // Force re-run via state toggle
          setRenderTick(t => t + 1);
        } else {
          // Give up after 5 retries — show graph anyway
          measuredRef.current = true;
          setLayoutReady(true);
        }
        return;
      }
      // Refresh textareas first (원본 node-graph.js refreshTextareas 패턴)
      // Skip user-resized nodes — their dimensions are locked
      const textareas = container.querySelectorAll<HTMLTextAreaElement>('textarea.ng-input-node-field');
      textareas.forEach(ta => {
        const nodeEl = ta.closest('[data-node-id]') as HTMLElement | null;
        const nid = nodeEl?.dataset.nodeId;
        if (nid && state.nodes.get(nid)?.userResized) return;
        ta.style.height = 'auto';
        void ta.offsetHeight;  // force reflow
        ta.style.height = ta.scrollHeight + 'px';
      });
      let needsRelayout = false;
      for (const node of state.nodes.values()) {
        if (node.userResized) continue;
        const el = container.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement;
        if (el) {
          const measured = el.offsetHeight;
          if (measured > 0 && Math.abs((node.height || 0) - measured) > 2) {
            updateNode(node.id, { height: measured });
            needsRelayout = true;
          }
        }
      }
      measuredRef.current = true;
      measureRetryRef.current = 0;
      if (needsRelayout) {
        requestAnimationFrame(() => {
          relayoutVertical(50);
          requestAnimationFrame(() => {
            // Only fitToView on first measurement — preserve user's pan/zoom after that
            if (!initialFitDone.current && containerRef.current) {
              if (fitToView(engine, containerRef.current)) {
                initialFitDone.current = true;
              }
            }
            setLayoutReady(true);
          });
        });
      } else {
        requestAnimationFrame(() => {
          if (!initialFitDone.current && containerRef.current) {
            if (fitToView(engine, containerRef.current)) {
              initialFitDone.current = true;
            }
          }
          setLayoutReady(true);
        });
      }
      // Delayed re-measurement: textarea autoResize may change node heights after initial render
      // Only do 2nd pass on first measurement — preserve sizes after that
      if (!initialFitDone.current) {
        setTimeout(() => {
          measuredRef.current = false;
          setRenderTick(t => t + 1);
        }, 350);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [nodesArray.length, state.nodes, updateNode, relayoutVertical, engine, renderTick]);

  // Re-measure and fitToView when tab becomes visible (display:none → visible)
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const wasHidden = !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || !wasHidden) return;
    if (nodesArray.length === 0) return;
    const timer = setTimeout(() => {
      if (containerRef.current) {
        // measuredRef 유지 — 노드 크기 보존 (userResized 포함)
        // renderTick만 갱신 — connection line이 새 DOM 좌표로 재계산
        setRenderTick(t => t + 1);
        setLayoutReady(true);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, nodesArray.length]);

  // Close detail modal when leaving graph tab
  useEffect(() => {
    if (!visible) setDetailNodeId(null);
  }, [visible]);

  // Wheel zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      // CreateNodeMenu 위에서는 메뉴 내 스크롤 우선
      if (target.closest('.ng-create-menu')) return;
      // Detail modal 위에서는 모달 내 스크롤 우선
      if (target.closest('.ng-detail-overlay')) return;
      // 스크롤 가능한 요소 위에서는 내부 스크롤 우선
      const scrollable = target.closest('.ng-node-body, .ng-input-node-body')
        || (target.matches('textarea, .ng-interactive') ? target : null);
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) return;
      e.preventDefault();
      setCreateMenu(null); // 메뉴 밖 wheel 시 메뉴 닫기
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const oldS = engine.state.scale;
      const newS = Math.max(0.2, Math.min(3, oldS * factor));
      engine.setViewport(mx - (mx - engine.state.panX) * (newS / oldS), my - (my - engine.state.panY) * (newS / oldS), newS);
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [engine]);

  // Port highlight helpers
  const highlightPorts = useCallback((pending: PendingConn) => {
    const container = containerRef.current;
    if (!container) return;
    const targetDir = pending.fromDir === 'out' ? 'in' : 'out';
    container.querySelectorAll<HTMLElement>('.ng-port').forEach(portEl => {
      const pnId = portEl.dataset.nodeId;
      const pDir = portEl.dataset.portDir;
      const pType = portEl.dataset.portType || 'any';
      if (pnId === pending.fromNodeId) {
        portEl.classList.add('ng-port-dimmed');
        return;
      }
      let ok: boolean;
      if (pending.connType === 'ref') {
        // Ref: 방향 검사 (flow와 동일 — output↔input만)
        if (pDir !== targetDir) {
          portEl.classList.add('ng-port-dimmed');
          return;
        }
        const d = pnId ? getNodeDef(state.nodes.get(pnId)?.type || '') : null;
        const pendingDef = getNodeDef(state.nodes.get(pending.fromNodeId)?.type || '');
        ok = !!d?.allowRef || !!pendingDef?.allowRef;
      } else {
        // Flow: 반대 방향만
        if (pDir !== targetDir) {
          portEl.classList.add('ng-port-dimmed');
          return;
        }
        if (pending.fromDir === 'out') {
          ok = PortTypes.isCompatible(pending.fromType, pType);
        } else {
          ok = PortTypes.isCompatible(pType, pending.fromType);
        }
      }
      portEl.classList.add(ok ? 'ng-port-compatible' : 'ng-port-dimmed');
    });
  }, [state.nodes]);

  const clearPortHighlights = useCallback(() => {
    containerRef.current?.querySelectorAll('.ng-port-compatible, .ng-port-dimmed, .ng-port-snap').forEach(el => {
      el.classList.remove('ng-port-compatible', 'ng-port-dimmed', 'ng-port-snap');
    });
  }, []);

  // Document mousemove/mouseup
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Node resize handling
      const resize = resizeRef.current;
      if (resize) {
        const s = engine.state.scale;
        const dx = (e.clientX - resize.startX) / s;
        const dy = (e.clientY - resize.startY) / s;
        const handle = resize.handle;
        const node = engine.state.nodes.get(resize.nodeId);
        const nodeDef = node ? getNodeDef(node.type) : null;
        const MIN_W = nodeDef?.minWidth || 100;
        const MIN_H = 40;
        let newX = resize.startNodeX, newY = resize.startNodeY;
        let newW = resize.startW, newH = resize.startH;
        if (handle.includes('e')) newW = Math.max(MIN_W, resize.startW + dx);
        if (handle.includes('w')) { newW = Math.max(MIN_W, resize.startW - dx); newX = resize.startNodeX + resize.startW - newW; }
        if (handle.includes('s')) newH = Math.max(MIN_H, resize.startH + dy);
        if (handle.includes('n')) { newH = Math.max(MIN_H, resize.startH - dy); newY = resize.startNodeY + resize.startH - newH; }
        if (node) {
          node.x = newX; node.y = newY; node.width = newW; node.height = newH;
          const el = containerRef.current?.querySelector(`[data-node-id="${resize.nodeId}"]`) as HTMLElement | null;
          if (el) { el.style.left = `${newX}px`; el.style.top = `${newY}px`; el.style.width = `${newW}px`; el.style.height = `${newH}px`; }
          // Trigger re-render for connection updates
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => { setRenderTick(t => t + 1); rafRef.current = 0; });
          }
        }
        return;
      }

      const pending = pendingConnRef.current;
      if (pending) {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const mx = (e.clientX - rect.left - engine.state.panX) / engine.state.scale;
        const my = (e.clientY - rect.top - engine.state.panY) / engine.state.scale;
        const snap = findSnapPort(pending, mx, my, engine.state, container);
        setPendingLine({ x1: pending.startX, y1: pending.startY, x2: snap?.x ?? mx, y2: snap?.y ?? my, isRef: pending.connType === 'ref' });
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;

      // Smart right-click: mark as moved once >5px
      const rc = rightClickRef.current;
      if (rc && !rc.moved) {
        if (Math.hypot(e.clientX - rc.startX, e.clientY - rc.startY) > 5) {
          rc.moved = true;
        } else {
          return; // Don't pan yet
        }
      }

      if (drag.type === 'pan') {
        engine.setViewport(drag.startPanX + dx, drag.startPanY + dy, engine.state.scale);
      } else if (drag.type === 'marquee') {
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const gx = (e.clientX - rect.left - engine.state.panX) / engine.state.scale;
        const gy = (e.clientY - rect.top - engine.state.panY) / engine.state.scale;
        const mx = Math.min(drag.startPanX, gx), my = Math.min(drag.startPanY, gy);
        const mw = Math.abs(gx - drag.startPanX), mh = Math.abs(gy - drag.startPanY);
        setMarquee({ x: mx, y: my, w: mw, h: mh });
      } else if (drag.type === 'node' && drag.nodeId) {
        const s = engine.state.scale;
        const primaryNewX = drag.startNodeX + dx / s;
        const primaryNewY = drag.startNodeY + dy / s;
        // Group drag: move all nodes in groupOffsets
        if (drag.groupOffsets && drag.groupOffsets.size > 1) {
          for (const [sid, offset] of drag.groupOffsets) {
            const sn = engine.state.nodes.get(sid);
            if (sn) {
              sn.x = primaryNewX + offset.dx;
              sn.y = primaryNewY + offset.dy;
              const el = containerRef.current?.querySelector(`[data-node-id="${sid}"]`) as HTMLElement | null;
              if (el) { el.style.left = `${sn.x}px`; el.style.top = `${sn.y}px`; }
            }
          }
        } else {
          const node = engine.state.nodes.get(drag.nodeId);
          if (node) {
            node.x = primaryNewX;
            node.y = primaryNewY;
            const el = containerRef.current?.querySelector(`[data-node-id="${drag.nodeId}"]`) as HTMLElement | null;
            if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
          }
        }
        // Trigger re-render for connection updates
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => { setRenderTick(t => t + 1); rafRef.current = 0; });
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      // Cancel any pending rAF
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }

      // Resize commit
      if (resizeRef.current) {
        const node = engine.state.nodes.get(resizeRef.current.nodeId);
        if (node) engine.addNode({ ...node, userResized: true });
        resizeRef.current = null;
        return;
      }

      // Smart right-click: if not moved, open create menu
      const rc = rightClickRef.current;
      if (rc && !rc.moved && (e.button === 2) && !detailNodeId) {
        const container = containerRef.current;
        if (container) {
          const target = e.target as HTMLElement;
          if (!target.closest('.ng-node') && !target.closest('.ng-port')) {
            const rect = container.getBoundingClientRect();
            const graphX = (e.clientX - rect.left - engine.state.panX) / engine.state.scale;
            const graphY = (e.clientY - rect.top - engine.state.panY) / engine.state.scale;
            setCreateMenu({ screenX: e.clientX - rect.left, screenY: e.clientY - rect.top, graphX, graphY });
          }
        }
        rightClickRef.current = null;
        dragRef.current = null;
        return;
      }
      rightClickRef.current = null;

      const pending = pendingConnRef.current;
      if (pending) {
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const mx = (e.clientX - rect.left - engine.state.panX) / engine.state.scale;
          const my = (e.clientY - rect.top - engine.state.panY) / engine.state.scale;
          const snap = findSnapPort(pending, mx, my, engine.state, container);
          if (snap) {
            engine.pushUndo();
            // Ref/Flow 동일: port 방향 기반 from/to 결정
            if (pending.fromDir === 'out') {
              engine.addConnection(pending.fromNodeId, pending.fromPort, snap.nodeId, snap.portName, pending.connType);
            } else {
              engine.addConnection(snap.nodeId, snap.portName, pending.fromNodeId, pending.fromPort, pending.connType);
            }
          }
        }
        pendingConnRef.current = null;
        setPendingLine(null);
        clearPortHighlights();
        return;
      }
      const drag = dragRef.current;
      if (drag?.type === 'marquee') {
        // Finalize marquee selection (E-9: Shift adds to existing)
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          const gx = (e.clientX - rect.left - engine.state.panX) / engine.state.scale;
          const gy = (e.clientY - rect.top - engine.state.panY) / engine.state.scale;
          const mx = Math.min(drag.startPanX, gx), my = Math.min(drag.startPanY, gy);
          const mw = Math.abs(gx - drag.startPanX), mh = Math.abs(gy - drag.startPanY);
          if (mw > 3 || mh > 3) {
            const newIds = new Set<string>();
            for (const [nid, n] of engine.state.nodes) {
              const nw = n.width || 180, nh = n.height || 80;
              if (n.x + nw > mx && n.x < mx + mw && n.y + nh > my && n.y < my + mh) {
                newIds.add(nid);
              }
            }
            // Shift+marquee: union with existing selection
            if (marqueeShiftRef.current) {
              const combined = new Set(engine.state.selectedNodeIds);
              for (const id of newIds) combined.add(id);
              engine.setSelectedNodes(combined);
            } else {
              engine.setSelectedNodes(newIds);
            }
          }
        }
        setMarquee(null);
      } else if (drag?.type === 'node') {
        // Commit positions for group drag — mark as userMoved to survive relayout
        if (drag.groupOffsets && drag.groupOffsets.size > 1) {
          for (const sid of drag.groupOffsets.keys()) {
            const sn = engine.state.nodes.get(sid);
            if (sn) engine.addNode({ ...sn, userMoved: true });
          }
        } else if (drag.nodeId) {
          const node = engine.state.nodes.get(drag.nodeId);
          if (node) engine.addNode({ ...node, userMoved: true });
        }
      }
      dragRef.current = null;
    };

    const doc = containerRef.current?.ownerDocument ?? document;
    doc.addEventListener('mousemove', handleMouseMove);
    doc.addEventListener('mouseup', handleMouseUp);
    return () => { doc.removeEventListener('mousemove', handleMouseMove); doc.removeEventListener('mouseup', handleMouseUp); };
  }, [engine, clearPortHighlights]);

  // Port mousedown → start pending connection
  const handlePortMouseDown = useCallback((e: React.MouseEvent, nodeId: string, portName: string, portDir: 'in' | 'out', portType: string) => {
    e.preventDefault();
    e.stopPropagation();
    const isRightClick = e.button === 2;

    // Input port: 재연결 로직
    if (portDir === 'in') {
      // 공통 (좌/우클릭): selected connection이 이 port에 연결된 경우 → 떼어서 재연결
      const selectedConn = state.selectedConnectionId
        ? state.connections.get(state.selectedConnectionId) : null;
      if (selectedConn && selectedConn.to === nodeId && selectedConn.toPort === portName) {
        removeConnection(selectedConn.id);
        const fromNode = state.nodes.get(selectedConn.from);
        if (fromNode) {
          const center = getPortCenter(fromNode, selectedConn.fromPort, 'out', containerRef.current);
          const p: PendingConn = {
            fromNodeId: selectedConn.from, fromPort: selectedConn.fromPort,
            fromDir: 'out', fromType: portType,
            connType: selectedConn.type,  // flow/ref 원래 타입 유지
            startX: center.x, startY: center.y,
          };
          pendingConnRef.current = p;
          highlightPorts(p);
          return;
        }
      }

      // Selected conn 없을 때: 클릭 타입별 fallback
      if (!isRightClick) {
        // 좌클릭 fallback: 아무 flow 떼어서 재연결
        for (const conn of state.connections.values()) {
          if (conn.to === nodeId && conn.toPort === portName && conn.type === 'flow') {
            removeConnection(conn.id);
            const fromNode = state.nodes.get(conn.from);
            if (fromNode) {
              const center = getPortCenter(fromNode, conn.fromPort, 'out', containerRef.current);
              const p: PendingConn = { fromNodeId: conn.from, fromPort: conn.fromPort,
                fromDir: 'out', fromType: portType, connType: 'flow',
                startX: center.x, startY: center.y };
              pendingConnRef.current = p;
              highlightPorts(p);
              return;
            }
          }
        }
      } else {
        // 우클릭 fallback: 아무 ref 떼어서 재연결
        for (const conn of state.connections.values()) {
          if (conn.to === nodeId && conn.toPort === portName && conn.type === 'ref') {
            removeConnection(conn.id);
            const fromNode = state.nodes.get(conn.from);
            if (fromNode) {
              const center = getPortCenter(fromNode, conn.fromPort, 'out', containerRef.current);
              const p: PendingConn = { fromNodeId: conn.from, fromPort: conn.fromPort,
                fromDir: 'out', fromType: portType, connType: 'ref',
                startX: center.x, startY: center.y };
              pendingConnRef.current = p;
              highlightPorts(p);
              return;
            }
          }
        }
        // ref 없으면 → 새 ref 시작 (fallthrough)
      }
    }

    // Output port 또는 input에 떼낼 conn 없을 때: 새 연결 시작
    const node = state.nodes.get(nodeId);
    if (!node) return;

    // Input/Math 카테고리 노드는 ref 연결 불가 (순수 값/연산 노드)
    const nodeDef = getNodeDef(node.type);
    const noRefCategories = ['Input', 'Math'];
    const canStartRef = nodeDef ? !noRefCategories.includes(nodeDef.category) : true;
    const connType: ConnectionType = (isRightClick && canStartRef) ? 'ref' : 'flow';

    // 우클릭인데 ref 불가능한 노드면 무시
    if (isRightClick && !canStartRef) return;

    const center = getPortCenter(node, portName, portDir, containerRef.current);
    const p: PendingConn = { fromNodeId: nodeId, fromPort: portName, fromDir: portDir, fromType: portType, connType, startX: center.x, startY: center.y };
    pendingConnRef.current = p;
    highlightPorts(p);
  }, [state.connections, state.nodes, state.selectedConnectionId, removeConnection, highlightPorts]);

  // Marquee shift state for additive selection
  const marqueeShiftRef = useRef(false);

  const handleContainerMouseDown = useCallback((e: React.MouseEvent) => {
    if (detailNodeId) return; // block all mouse interactions while modal is open
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      // Smart right-click: start tracking, defer pan until 5px movement
      rightClickRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, startPanX: state.panX, startPanY: state.panY, startNodeX: 0, startNodeY: 0 };
    }
    if (e.button === 0) {
      const target = e.target as HTMLElement;
      if (target.closest('.ng-node') || target.closest('.ng-create-menu') || target.closest('.ng-zoom-controls')) return;
      // Left-click on empty → start marquee
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        selectNode(null);
      }
      marqueeShiftRef.current = e.shiftKey;
      setCreateMenu(null);
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const gx = (e.clientX - rect.left - state.panX) / state.scale;
      const gy = (e.clientY - rect.top - state.panY) / state.scale;
      dragRef.current = { type: 'marquee', startX: e.clientX, startY: e.clientY, startPanX: gx, startPanY: gy, startNodeX: 0, startNodeY: 0 };
      setMarquee({ x: gx, y: gy, w: 0, h: 0 });
    }
  }, [state.panX, state.panY, state.scale, selectNode, detailNodeId]);

  // Double-click on empty area → Create Node menu
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (detailNodeId) return; // block while modal is open
    // Only on background (not on nodes)
    const target = e.target as HTMLElement;
    if (target.closest('.ng-node') || target.closest('.ng-create-menu') || target.closest('.ng-zoom-controls')) return;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const graphX = (e.clientX - rect.left - state.panX) / state.scale;
    const graphY = (e.clientY - rect.top - state.panY) / state.scale;
    setCreateMenu({ screenX: e.clientX - rect.left, screenY: e.clientY - rect.top, graphX, graphY });
  }, [state.panX, state.panY, state.scale, detailNodeId]);

  // Double-click on node body → open detail modal
  const handleNodeDoubleClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    // Header double-click is for title editing — skip
    if ((e.target as HTMLElement).closest('.ng-node-header')) return;
    e.stopPropagation();
    setCreateMenu(null); // close create menu if open
    setDetailNodeId(nodeId);
  }, []);

  // Create a new node from menu selection
  const handleCreateNode = useCallback((type: string) => {
    const def = getNodeDef(type);
    if (!def || !createMenu) return;
    pushUndo();
    const id = `user-node-${nextNodeIdRef.current++}`;
    engine.addNode({
      id,
      type,
      title: def.defaultConfig.title,
      tool: def.defaultConfig.tool || '',
      x: createMenu.graphX,
      y: createMenu.graphY,
      width: def.minWidth || 180,
      status: (def.defaultConfig.status as NodeData['status']) || 'pending',
      stepNum: def.defaultConfig.stepNum || '',
      portValues: def.defaultConfig.portValues ? { ...def.defaultConfig.portValues } : undefined,
    });
    setCreateMenu(null);
  }, [createMenu, engine, pushUndo]);

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.ng-port')) return;
    e.stopPropagation();

    const isMultiKey = e.ctrlKey || e.metaKey;
    if (isMultiKey) {
      toggleSelectNode(nodeId);
      return;
    }

    // If clicking a node already in multi-selection, keep selection for group drag
    if (!state.selectedNodeIds.has(nodeId)) {
      selectNode(nodeId);
    }

    const node = state.nodes.get(nodeId);
    if (!node) return;

    // Build group offsets for all selected nodes (for group drag)
    const groupOffsets = new Map<string, { dx: number; dy: number }>();
    const selectedIds = state.selectedNodeIds.has(nodeId) ? state.selectedNodeIds : new Set([nodeId]);
    for (const sid of selectedIds) {
      const sn = state.nodes.get(sid);
      if (sn) groupOffsets.set(sid, { dx: sn.x - node.x, dy: sn.y - node.y });
    }
    pushUndo();
    dragRef.current = { type: 'node', nodeId, startX: e.clientX, startY: e.clientY, startPanX: state.panX, startPanY: state.panY, startNodeX: node.x, startNodeY: node.y, groupOffsets };
  }, [state.nodes, state.panX, state.panY, state.selectedNodeIds, selectNode, toggleSelectNode, pushUndo]);

  // Left-click on connection → select it
  const handleConnectionClick = useCallback((connId: string) => { selectConnection(connId); }, [selectConnection]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  // Keyboard shortcuts: Delete, Ctrl+C, Ctrl+V
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      // Ctrl+Z → undo, Ctrl+Shift+Z / Ctrl+Y → redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
        return;
      }

      // Delete/Backspace → delete selected
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedConnectionId) {
          pushUndo();
          removeConnection(state.selectedConnectionId);
          selectConnection(null);
          e.preventDefault();
        } else if (state.selectedNodeIds.size > 0) {
          pushUndo();
          removeNodes([...state.selectedNodeIds]);
          e.preventDefault();
        } else if (state.selectedNodeId) {
          pushUndo();
          removeNode(state.selectedNodeId);
          selectNode(null);
          e.preventDefault();
        }
      }

      // Ctrl+A → select all
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        engine.setSelectedNodes(new Set(state.nodes.keys()));
      }

      // Ctrl+C → copy selected nodes
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const ids = state.selectedNodeIds.size > 0 ? state.selectedNodeIds : (state.selectedNodeId ? new Set([state.selectedNodeId]) : null);
        if (!ids || ids.size === 0) return;
        const copiedNodes: NodeData[] = [];
        for (const nid of ids) {
          const n = state.nodes.get(nid);
          if (n) copiedNodes.push({ ...n });
        }
        // Copy connections between selected nodes
        const copiedConns: ConnectionData[] = [];
        for (const conn of state.connections.values()) {
          if (ids.has(conn.from) && ids.has(conn.to)) {
            copiedConns.push({ ...conn });
          }
        }
        clipboardRef.current = { nodes: copiedNodes, connections: copiedConns };
      }

      // Ctrl+V → paste at viewport center
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        const clip = clipboardRef.current;
        if (!clip || clip.nodes.length === 0) return;
        e.preventDefault();
        pushUndo();

        // Calculate clipboard center
        let clipMinX = Infinity, clipMinY = Infinity, clipMaxX = -Infinity, clipMaxY = -Infinity;
        for (const n of clip.nodes) {
          if (n.x < clipMinX) clipMinX = n.x;
          if (n.y < clipMinY) clipMinY = n.y;
          if (n.x + (n.width || 180) > clipMaxX) clipMaxX = n.x + (n.width || 180);
          if (n.y + (n.height || 80) > clipMaxY) clipMaxY = n.y + (n.height || 80);
        }
        const clipCenterX = (clipMinX + clipMaxX) / 2;
        const clipCenterY = (clipMinY + clipMaxY) / 2;

        // Viewport center in graph coordinates
        const container = containerRef.current;
        let targetX = clipCenterX + 30, targetY = clipCenterY + 30;
        if (container) {
          const vc = getViewportCenterGraphPos(container, state.panX, state.panY, state.scale);
          targetX = vc.x;
          targetY = vc.y;
        }

        const offsetX = targetX - clipCenterX;
        const offsetY = targetY - clipCenterY;

        const idMap = new Map<string, string>();
        const pastedIds = new Set<string>();
        for (const n of clip.nodes) {
          const newId = `paste-${nextNodeIdRef.current++}`;
          idMap.set(n.id, newId);
          pastedIds.add(newId);
          engine.addNode({ ...n, id: newId, x: n.x + offsetX, y: n.y + offsetY });
        }
        for (const c of clip.connections) {
          const newFrom = idMap.get(c.from);
          const newTo = idMap.get(c.to);
          if (newFrom && newTo) {
            engine.addConnection(newFrom, c.fromPort, newTo, c.toPort, c.type);
          }
        }
        engine.setSelectedNodes(pastedIds);
        // Update clipboard so next paste offsets further
        clipboardRef.current = {
          nodes: clip.nodes.map(n => ({ ...n, x: n.x + offsetX + 30, y: n.y + offsetY + 30 })),
          connections: clip.connections,
        };
      }
    };
    const doc = containerRef.current?.ownerDocument ?? document;
    doc.addEventListener('keydown', handleKeyDown);
    return () => doc.removeEventListener('keydown', handleKeyDown);
  }, [state.selectedConnectionId, state.selectedNodeId, state.selectedNodeIds, state.nodes, state.connections, removeConnection, removeNode, removeNodes, selectConnection, selectNode, engine, pushUndo, undo, redo]);
  const handleTitleChange = useCallback((id: string, title: string) => {
    setNodeTitle(id, title);
    // Sync step node title back to plan
    if (id.startsWith('step-')) {
      const stepIndex = parseInt(id.split('-')[1]) - 1;
      if (stepIndex >= 0) {
        appDispatch({ type: 'UPDATE_STEP_NAME', payload: { stepIndex, name: title } });
      }
    }
  }, [setNodeTitle, appDispatch]);
  const handlePortValueChange = useCallback((nId: string, pName: string, val: unknown) => { setPortValue(nId, pName, val); }, [setPortValue]);

  // Node resize start
  const handleResizeStart = useCallback((e: React.MouseEvent, nodeId: string, handle: string) => {
    e.preventDefault();
    const node = state.nodes.get(nodeId);
    if (!node) return;
    pushUndo();
    resizeRef.current = {
      nodeId, handle,
      startX: e.clientX, startY: e.clientY,
      startNodeX: node.x, startNodeY: node.y,
      startW: node.width || 180, startH: node.height || 80,
    };
  }, [state.nodes, pushUndo]);

  const graphCtx = useMemo(() => ({ onPortMouseDown: handlePortMouseDown }), [handlePortMouseDown]);

  // 각 노드별 flow 연결된 input port 집합 계산 (ref는 데이터 전달이 아니므로 제외)
  const connectedPortsMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const conn of state.connections.values()) {
      if (conn.type !== 'flow') continue;
      if (!map.has(conn.to)) map.set(conn.to, new Set());
      map.get(conn.to)!.add(conn.toPort);
    }
    return map;
  }, [state.connections]);

  return (
    <GraphProvider value={graphCtx}>
      <div className="node-graph-container" ref={containerRef} onMouseDown={handleContainerMouseDown} onDoubleClick={handleDoubleClick} onContextMenu={handleContextMenu}
        style={{
          backgroundSize: `${20 * state.scale}px ${20 * state.scale}px`,
          backgroundPosition: `${state.panX}px ${state.panY}px`,
        }}>
        {/* SVG: container 직속 자식 → 100% = 실제 크기, own transform */}
        <svg className="node-graph-svg" style={{ transform: `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`, transformOrigin: '0 0', opacity: layoutReady ? 1 : 0, transition: 'opacity 0.15s ease-in' }}>
          {connectionsArray.map(conn => (
            <ConnectionLine key={conn.id} connection={conn} nodes={state.nodes} containerEl={containerRef.current}
              selected={conn.id === state.selectedConnectionId} onClick={handleConnectionClick} />
          ))}
          {pendingLine && <PendingConnectionLine x1={pendingLine.x1} y1={pendingLine.y1} x2={pendingLine.x2} y2={pendingLine.y2} isRef={pendingLine.isRef} />}
        </svg>
        {/* Viewport: 노드만 포함 */}
        <div className="node-graph-viewport" style={{ transform: `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`, transformOrigin: '0 0', opacity: layoutReady ? 1 : 0, transition: 'opacity 0.15s ease-in' }}>
          <div className="node-graph-canvas">
            {nodesArray.map(node => (
              <GraphNode key={node.id} node={node}
                selected={node.id === state.selectedNodeId}
                multiSelected={state.selectedNodeIds.has(node.id)}
                connectedPorts={connectedPortsMap.get(node.id)}
                onTitleChange={handleTitleChange} onPortValueChange={handlePortValueChange} onMouseDown={handleNodeMouseDown} onResizeStart={handleResizeStart} onDoubleClick={handleNodeDoubleClick} />
            ))}
          </div>
        </div>
        {marquee && marquee.w + marquee.h > 3 && (
          <div className="ng-marquee" style={{
            left: marquee.x * state.scale + state.panX,
            top: marquee.y * state.scale + state.panY,
            width: marquee.w * state.scale,
            height: marquee.h * state.scale,
          }} />
        )}
        <div className="ng-zoom-controls">
          <button className="ng-zoom-btn" onClick={() => setViewport(state.panX, state.panY, Math.min(3, state.scale * 1.2))} title="Zoom In">+</button>
          <button className="ng-zoom-btn" onClick={() => setViewport(state.panX, state.panY, Math.max(0.2, state.scale / 1.2))} title="Zoom Out">−</button>
          <button className="ng-zoom-btn" onClick={() => containerRef.current && fitToView(engine, containerRef.current)} title="Reset Zoom">⌂</button>
          <button className="ng-help-btn" onClick={() => window.open('https://github.com/your-repo/biomni-web', '_blank')} title="Help">?</button>
        </div>
        {createMenu && (
          <CreateNodeMenu
            x={createMenu.screenX}
            y={createMenu.screenY}
            onSelect={handleCreateNode}
            onClose={() => setCreateMenu(null)}
          />
        )}
        {detailNodeId && state.nodes.get(detailNodeId) && (
          <NodeDetailModal
            node={state.nodes.get(detailNodeId)!}
            onClose={() => setDetailNodeId(null)}
            onTitleChange={handleTitleChange}
            onDescriptionChange={(id, desc) => setNodeDescription(id, desc)}
            onPortValueChange={handlePortValueChange}
          />
        )}
      </div>
    </GraphProvider>
  );
}

function findSnapPort(pending: PendingConn, mx: number, my: number,
  gs: { nodes: Map<string, NodeData> }, container: HTMLElement | null,
): { nodeId: string; portName: string; x: number; y: number } | null {
  const SNAP = 15;
  const targetDir = pending.fromDir === 'out' ? 'in' : 'out';
  let best: { nodeId: string; portName: string; x: number; y: number } | null = null;
  let bestDist = SNAP;
  for (const [nId, node] of gs.nodes) {
    if (nId === pending.fromNodeId) continue;
    const def = getNodeDef(node.type);
    if (!def) continue;
    // Ref/Flow 모두 반대 방향 포트만 (output↔input)
    const portsToCheck = def.ports.filter(pp => pp.dir === targetDir);
    for (const p of portsToCheck) {
      let ok: boolean;
      if (pending.connType === 'ref') {
        // 둘 중 하나가 allowRef면 연결 가능
        const pendingDef = getNodeDef(gs.nodes.get(pending.fromNodeId)?.type || '');
        ok = !!def.allowRef || !!pendingDef?.allowRef;
        // Forward ref 차단: step끼리 같은 depth 불가
        if (ok) {
          const pendingNode = gs.nodes.get(pending.fromNodeId);
          if (pendingNode?.stepNum && node.stepNum) {
            const pendingNum = parseFloat(pendingNode.stepNum);
            const nodeNum = parseFloat(node.stepNum);
            if (pendingNum === nodeNum) ok = false;
          }
        }
      } else if (pending.fromDir === 'out') {
        ok = PortTypes.isCompatible(pending.fromType, p.type);
      } else {
        ok = PortTypes.isCompatible(p.type, pending.fromType);
      }
      if (!ok) continue;
      const c = getPortCenter(node, p.name, p.dir, container);
      const d = Math.hypot(mx - c.x, my - c.y);
      if (d < bestDist) { bestDist = d; best = { nodeId: nId, portName: p.name, x: c.x, y: c.y }; }
    }
  }
  return best;
}

function fitToView(engine: GraphEngine, container: HTMLElement, padding = 40): boolean {
  const nodes = Array.from(engine.state.nodes.values());
  if (nodes.length === 0) return false;
  const cw = container.clientWidth, ch = container.clientHeight;
  if (cw === 0 || ch === 0) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    // 원본 node-graph.js fitToView 패턴: DOM el.offsetWidth/Height 사용
    const el = container.querySelector(`[data-node-id="${n.id}"]`) as HTMLElement | null;
    const w = el ? el.offsetWidth : (n.width || 180);
    const h = el ? el.offsetHeight : (n.height || 80);
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  const cW = maxX - minX, cH = maxY - minY;
  if (cW <= 0 || cH <= 0) return false;
  // Cap scale at 1.0 (don't zoom in, only zoom out to fit)
  const s = Math.max(0.2, Math.min(1, Math.min((cw - padding * 2) / cW, (ch - padding * 2) / cH)));
  engine.setViewport((cw - cW * s) / 2 - minX * s, (ch - cH * s) / 2 - minY * s, s);
  return true;
}

function getViewportCenterGraphPos(
  container: HTMLElement,
  panX: number, panY: number, scale: number,
): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  return {
    x: (rect.width / 2 - panX) / scale,
    y: (rect.height / 2 - panY) / scale,
  };
}
