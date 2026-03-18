// ============================================
// Graph Tab — integrates graph engine with AppContext
// ============================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { useTranslation } from '@/i18n';
import { useGraphEngine } from '@/graph/useGraphEngine';
import { createFromPlan, createEmptyGraph } from '@/graph/createFromPlan';
import { GraphCanvas } from '@/graph/GraphCanvas';
import { GraphPopout } from './GraphPopout';
import { toExecutionPlan, getExecutionPlanHash, canStartFromGraph } from '@/graph/toExecutionPlan';
import { createConversation } from '@/api/conversations';
import { initDynamicNodes } from '@/graph/nodes';
import type { NodeStatus, SerializedGraphState } from '@/graph/types';

function graphStateKey(convId: string, planIndex: number) {
  return `graphState-${convId}-${planIndex}`;
}

export function GraphTab() {
  const { state, dispatch: appDispatch } = useAppContext();
  const { state: chatState, dispatch: chatDispatch } = useChatContext();
  const { sendRaw } = useWebSocket();
  const { t } = useTranslation();
  const engine = useGraphEngine();
  const engineRef = useRef(engine);
  engineRef.current = engine;
  const lastPlanRef = useRef<string>('');
  const lastPlanHashRef = useRef<string | null>(null);
  const manualGraphRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convId = chatState.conversationId;
  const [dynamicReady, setDynamicReady] = useState(false);

  // Initialize dynamic nodes (Tool, Library, DataLake) from backend API
  useEffect(() => {
    initDynamicNodes().then(() => setDynamicReady(true));
  }, []);

  // Try to restore from localStorage
  const restoredRef = useRef(false);
  // Reset restoration flag when conversation changes
  useEffect(() => {
    restoredRef.current = false;
    manualGraphRef.current = false;
    lastPlanRef.current = '';
    lastPlanHashRef.current = null;
  }, [convId]);
  useEffect(() => {
    if (!convId || restoredRef.current) return;
    const key = graphStateKey(convId, 0);
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const parsed: SerializedGraphState = JSON.parse(stored);
        engineRef.current.setState(parsed);
        restoredRef.current = true;
        // Compute hash from parsed data directly (state hasn't updated yet)
        const nodesMap = new Map(parsed.nodes.map(n => [n.id, n]));
        const connsMap = new Map(parsed.connections.map(c => [c.id, c]));
        lastPlanHashRef.current = getExecutionPlanHash(nodesMap, connsMap);
      } catch { /* ignore corrupted data */ }
    }
  }, [convId]);

  // Save to localStorage on changes (debounced)
  useEffect(() => {
    if (!convId) return;
    if (engine.state.nodes.size === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const key = graphStateKey(convId, 0);
      const serialized = engine.getSerializedState();
      localStorage.setItem(key, JSON.stringify(serialized));
    }, 500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [engine.state.nodes, engine.state.connections, engine.state.panX, engine.state.panY, engine.state.scale, convId, engine]);

  // Build graph from plan data when detailPanelData changes
  // Uses engineRef to avoid stale closure issues (engine object changes on every state mutation)
  useEffect(() => {
    const eng = engineRef.current;
    const data = state.detailPanelData;
    if (!data?.steps?.length) {
      // Plan cleared (e.g. conversation deleted) → clear graph engine too
      // But preserve manually-created graphs (via "Create Empty Graph" button)
      if (eng.state.nodes.size > 0 && !manualGraphRef.current) {
        eng.clear();
        lastPlanRef.current = '';
      }
      return;
    }
    manualGraphRef.current = false; // plan data arrived → manual flag no longer needed

    // Avoid rebuilding for the same plan — just update statuses
    const planKey = JSON.stringify(data.steps.map(s => `${s.name}|${s.description}`));
    if (planKey === lastPlanRef.current) {
      data.steps.forEach((step, i) => {
        const nodeId = `step-${i + 1}`;
        if (step.status) eng.setNodeStatus(nodeId, step.status as NodeStatus);
        if (step.tool) eng.setNodeTool(nodeId, step.tool);
      });
      // Update analysis node status
      const allDone = data.steps.every(
        s => s.status === 'completed' || s.status === 'error' || s.status === 'stopped',
      );
      if (data.analysis && typeof data.analysis === 'string' && data.analysis.trim().length > 0) {
        eng.setNodeStatus('analysis-node', 'completed' as NodeStatus);
      } else if (allDone) {
        eng.setNodeStatus('analysis-node', 'running' as NodeStatus);
      }
      return;
    }

    // If we already restored from localStorage, check if it matches the current plan
    if (restoredRef.current) {
      restoredRef.current = false;
      // Verify restored graph matches current plan (count + names)
      const restoredSteps = [...eng.state.nodes.values()]
        .filter((n) => n.type === 'step')
        .sort((a, b) => (a.stepNum || '').localeCompare(b.stepNum || ''));
      const namesMatch = restoredSteps.length === data.steps.length &&
        restoredSteps.every((n, i) => n.title === data.steps[i].name);
      if (namesMatch) {
        // Match — just update statuses and skip rebuild
        lastPlanRef.current = planKey;
        data.steps.forEach((step, i) => {
          const nodeId = `step-${i + 1}`;
          if (step.status) eng.setNodeStatus(nodeId, step.status as NodeStatus);
          if (step.tool) eng.setNodeTool(nodeId, step.tool);
        });
        return;
      }
      // Mismatch — fall through to full rebuild
    }

    lastPlanRef.current = planKey;

    // Map DetailPanelData → PlanData format for createFromPlan
    const lastUserMsg = chatState.messages
      ?.filter((m: { role: string }) => m.role === 'user')
      .pop()?.content || '';

    const planData = {
      goal: data.goal,
      userMessage: lastUserMsg,
      steps: data.steps.map((step, i) => ({
        id: `${i + 1}`,
        name: step.name,
        description: step.description,
        tool: step.tool || '',
      })),
    };

    // Build new graph via single atomic setState (avoids stale closure from incremental mutations)
    const { nodes: newNodes, connections: newConnections } = createFromPlan(planData);
    const planManagedIds = new Set(newNodes.map(n => n.id));

    // Preserve user-added nodes/connections (not managed by plan)
    const userNodes = [...eng.state.nodes.values()]
      .filter(n => !planManagedIds.has(n.id));
    const userConnections = [...eng.state.connections.values()]
      .filter(c => !planManagedIds.has(c.from) || !planManagedIds.has(c.to));

    // Merge plan nodes with preserved user positions
    const mergedNodes = newNodes.map(node => {
      const existing = eng.state.nodes.get(node.id);
      if (existing?.userMoved || existing?.userResized) {
        return {
          ...node,
          x: existing.userMoved ? existing.x : node.x,
          y: existing.userMoved ? existing.y : node.y,
          width: existing.userResized ? existing.width : node.width,
          height: existing.userResized ? existing.height : node.height,
          userMoved: existing.userMoved,
          userResized: existing.userResized,
        };
      }
      return node;
    });

    // Apply step statuses and tools to merged nodes
    data.steps.forEach((step, i) => {
      const nodeId = `step-${i + 1}`;
      const node = mergedNodes.find(n => n.id === nodeId);
      if (node) {
        if (step.status) node.status = step.status as NodeStatus;
        if (step.tool) node.tool = step.tool;
      }
    });

    // Update analysis node status
    const allStepsDone = data.steps.length > 0 && data.steps.every(
      s => s.status === 'completed' || s.status === 'error' || s.status === 'stopped',
    );
    const analysisNode = mergedNodes.find(n => n.id === 'analysis-node');
    if (analysisNode) {
      if (data.analysis && typeof data.analysis === 'string' && data.analysis.trim().length > 0) {
        analysisNode.status = 'completed' as NodeStatus;
      } else if (allStepsDone) {
        analysisNode.status = 'running' as NodeStatus;
      }
    }

    // Single atomic state update — no stale closure reads between mutations
    eng.setState({
      nodes: [...mergedNodes, ...userNodes],
      connections: [...newConnections, ...userConnections],
      panX: eng.state.panX,
      panY: eng.state.panY,
      scale: eng.state.scale,
    });

    // Snapshot plan hash from the new state (use newNodes/newConnections directly)
    const nodesMap = new Map(mergedNodes.map(n => [n.id, n]));
    const connsMap = new Map(newConnections.map(c => [c.id, c]));
    lastPlanHashRef.current = getExecutionPlanHash(nodesMap, connsMap);
  }, [state.detailPanelData, chatState.messages]);

  // Check if graph has been modified from original plan
  const hasExecutionLogicChanged = useCallback(() => {
    const newHash = getExecutionPlanHash(engine.state.nodes, engine.state.connections);
    return newHash !== lastPlanHashRef.current;
  }, [engine.state.nodes, engine.state.connections]);

  // Export execution plan from graph
  const getExecutionPlan = useCallback(() => {
    return toExecutionPlan(engine.state.nodes, engine.state.connections);
  }, [engine.state.nodes, engine.state.connections]);

  // Expose for parent components (via data attributes or future context)
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__graphEngine = {
      hasExecutionLogicChanged,
      getExecutionPlan,
      getState: engine.getSerializedState,
    };
    return () => { delete (window as unknown as Record<string, unknown>).__graphEngine; };
  }, [hasExecutionLogicChanged, getExecutionPlan, engine.getSerializedState]);

  // Re-run Plan handler
  const handleRerunPlan = useCallback(() => {
    const plan = toExecutionPlan(engine.state.nodes, engine.state.connections);
    if (!plan || !convId) return;

    // Save undo snapshot before rerun resets
    engine.pushUndo();

    const logicChanged = hasExecutionLogicChanged();

    // Reset all nodes to pending
    for (const nodeId of engine.state.nodes.keys()) {
      engine.setNodeStatus(nodeId, 'pending');
      engine.setNodeTool(nodeId, '');
    }

    if (logicChanged) {
      // Modified Rerun: update plan box with new steps
      appDispatch({
        type: 'SET_DETAIL_PANEL_DATA',
        payload: {
          goal: plan.goal || state.detailPanelData?.goal || '',
          steps: plan.steps.map(s => ({
            name: s.name,
            description: s.description,
            status: 'pending' as const,
          })),
          results: [],
          codes: {},
          analysis: '',
          currentStep: 0,
        },
      });
    } else {
      // Rerun: reset results only
      appDispatch({ type: 'RESET_STEP_RESULTS' });
    }

    // Send rerun via WS
    sendRaw('chat', {
      conv_id: convId,
      message: '',
      mode: 'plan',
      rerun: true,
      rerun_steps: plan.steps,
      rerun_goal: plan.goal || state.detailPanelData?.goal || '',
    });

    // Update hash
    lastPlanHashRef.current = getExecutionPlanHash(engine.state.nodes, engine.state.connections);
  }, [engine, convId, state.detailPanelData, hasExecutionLogicChanged, appDispatch, sendRaw]);

  // Start execution directly from Graph (no existing conversation needed)
  const handleStartFromGraph = useCallback(async () => {
    const eng = engineRef.current;
    const plan = toExecutionPlan(eng.state.nodes, eng.state.connections);
    if (!plan || plan.steps.length === 0) return;

    // Save undo snapshot & reset all nodes to pending
    eng.pushUndo();
    for (const nodeId of eng.state.nodes.keys()) {
      eng.setNodeStatus(nodeId, 'pending');
      eng.setNodeTool(nodeId, '');
    }

    // Initialize plan box
    appDispatch({
      type: 'SET_DETAIL_PANEL_DATA',
      payload: {
        goal: plan.goal || '',
        steps: plan.steps.map(s => ({
          name: s.name,
          description: s.description,
          status: 'pending' as const,
        })),
        results: [],
        codes: {},
        analysis: '',
        currentStep: 0,
      },
    });

    // Create conversation if needed
    let targetConvId = convId;
    if (!targetConvId) {
      const title = plan.goal
        ? plan.goal.substring(0, 50) + (plan.goal.length > 50 ? '...' : '')
        : 'Graph Execution';
      const newConv = await createConversation({ title });
      targetConvId = newConv.id;
      chatDispatch({ type: 'SET_CONVERSATION_ID', payload: targetConvId });
      appDispatch({ type: 'BUMP_CONVERSATIONS' });
      // Wait for WS connection (WebSocketContext connects on conversationId change)
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => { clearInterval(timer); resolve(); }, 100);
        setTimeout(() => { clearInterval(timer); resolve(); }, 3000);
      });
    }

    // Send as rerun — backend handles rerun=True without needing original chat message
    sendRaw('chat', {
      conv_id: targetConvId,
      message: plan.goal || '',
      mode: 'plan',
      rerun: true,
      rerun_steps: plan.steps,
      rerun_goal: plan.goal || '',
    });

    // Update hash
    lastPlanHashRef.current = getExecutionPlanHash(eng.state.nodes, eng.state.connections);
  }, [convId, appDispatch, chatDispatch, sendRaw]);

  const handleCreateEmptyGraph = useCallback(() => {
    const lastUserMsg = (chatState.messages || [])
      .filter((m: { role: string }) => m.role === 'user')
      .pop()?.content || '';
    const { nodes, connections } = createEmptyGraph(lastUserMsg);
    engine.setState({ nodes, connections, panX: 0, panY: 0, scale: 1 });
    manualGraphRef.current = true;
  }, [engine, chatState.messages]);

  const hasNodes = engine.state.nodes.size > 0;
  const [isPopout, setIsPopout] = useState(false);

  if (!hasNodes) {
    return (
      <div className="detail-empty-state">
        <p>{t('empty.graph_hint')}</p>
        <button className="graph-create-btn" onClick={handleCreateEmptyGraph}>
          {t('graph.create_empty')}
        </button>
      </div>
    );
  }

  return (
    <div className="graph-tab-wrapper">
      <div className="graph-tab-header">
        <span className="graph-tab-label">{t('graph.editor_title')}</span>
        <div className="graph-tab-header-actions">
          <button className="graph-popout-btn" onClick={() => setIsPopout(true)} title={t('tooltip.popout')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8V19a2 2 0 0 0 2 2h11" />
              <rect x="8" y="3" width="13" height="13" rx="2" />
              <path d="M12 12l3-3m0 0v2.5m0-2.5h-2.5" />
            </svg>
          </button>
          {convId ? (
            <button className="graph-rerun-btn" onClick={handleRerunPlan}>
              {t('graph.rerun')}
            </button>
          ) : canStartFromGraph(engine.state.nodes, engine.state.connections) ? (
            <button className="graph-start-btn" onClick={handleStartFromGraph}>
              {t('graph.start') || '▶ Start'}
            </button>
          ) : null}
        </div>
      </div>
      {isPopout ? (
        <>
          <GraphPopout onClose={() => setIsPopout(false)}>
            <GraphCanvas key="popout" engine={engine} skipInitialLayout={restoredRef.current} />
          </GraphPopout>
          <div className="graph-popout-notice">
            <span>{t('empty.graph_popout') || 'Graph is open in a separate window'}</span>
            <button onClick={() => setIsPopout(false)}>{t('label.close') || 'Close'}</button>
          </div>
        </>
      ) : (
        <GraphCanvas key="inline" engine={engine} visible={state.activeDetailTab === 'graph'} skipInitialLayout={restoredRef.current} />
      )}
    </div>
  );
}
