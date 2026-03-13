// ============================================
// Graph Tab — integrates graph engine with AppContext
// ============================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useChatContext } from '@/context/ChatContext';
import { useWebSocket } from '@/context/WebSocketContext';
import { useTranslation } from '@/i18n';
import { useGraphEngine } from '@/graph/useGraphEngine';
import { createFromPlan } from '@/graph/createFromPlan';
import { GraphCanvas } from '@/graph/GraphCanvas';
import { GraphPopout } from './GraphPopout';
import { toExecutionPlan, getExecutionPlanHash } from '@/graph/toExecutionPlan';
import type { NodeStatus, SerializedGraphState } from '@/graph/types';

function graphStateKey(convId: string, planIndex: number) {
  return `graphState-${convId}-${planIndex}`;
}

export function GraphTab() {
  const { state, dispatch: appDispatch } = useAppContext();
  const { state: chatState } = useChatContext();
  const { sendRaw } = useWebSocket();
  const { t } = useTranslation();
  const engine = useGraphEngine();
  const lastPlanRef = useRef<string>('');
  const lastPlanHashRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const convId = chatState.conversationId;

  // Try to restore from localStorage
  const restoredRef = useRef(false);
  // Reset restoration flag when conversation changes
  useEffect(() => {
    restoredRef.current = false;
    lastPlanRef.current = '';
  }, [convId]);
  useEffect(() => {
    if (!convId || restoredRef.current) return;
    const key = graphStateKey(convId, 0);
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const parsed: SerializedGraphState = JSON.parse(stored);
        engine.setState(parsed);
        restoredRef.current = true;
        lastPlanHashRef.current = getExecutionPlanHash(engine.state.nodes, engine.state.connections);
      } catch { /* ignore corrupted data */ }
    }
  }, [convId, engine]);

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
  useEffect(() => {
    const data = state.detailPanelData;
    if (!data?.steps?.length) return;

    // Avoid rebuilding for the same plan
    const planKey = JSON.stringify(data.steps.map((s: any) => 
      typeof s === 'string' ? s : (s.name || s.task || s.description || s.tool || '')
    ));

    if (planKey === lastPlanRef.current) {
      // Just update step statuses and tools
      data.steps.forEach((step: any, i) => {
        const nodeId = `step-${i + 1}`;
        const status = typeof step === 'string' ? 'pending' : step.status;
        const tool = typeof step === 'string' ? '' : step.tool;

        if (status) {
          engine.setNodeStatus(nodeId, step.status as NodeStatus);
        }
        if (tool) {
          engine.setNodeTool(nodeId, step.tool);
        }
      });
      return;
    }

    lastPlanRef.current = planKey;

    // If we already restored from localStorage, skip rebuilding
    if (restoredRef.current) {
      restoredRef.current = false;
      lastPlanRef.current = planKey;
      return;
    }

    lastPlanRef.current = planKey;

    // Map DetailPanelData → PlanData format for createFromPlan
    const planData = {
      goal: data.goal,
      steps: data.steps.map((step: any, i) => {
        const isString = typeof step === 'string';
        return {
          id: `${i + 1}`,
          name: isString ? `Step ${i + 1}` : (step.name || step.task || step.title || `Step ${i + 1}`),
          description: isString ? step : (step.description || step.details || step.name || ''),
          tool: isString ? '' : (step.tool || step.action || ''),
          status: isString ? 'pending' : (step.status || 'pending')
        };
      }),
    };

    // Build new graph
    const { nodes, connections } = createFromPlan(planData);
    engine.clear();
    for (const node of nodes) engine.addNode(node);
    for (const conn of connections) {
      engine.addConnection(conn.from, conn.fromPort, conn.to, conn.toPort, conn.type);
    }

    // Apply initial step statuses and tools
    data.steps.forEach((step: any, i) => {
      const nodeId = `step-${i + 1}`;
      const status = typeof step === 'string' ? 'pending' : step.status;
      const tool = typeof step === 'string' ? '' : step.tool;
      
      if (status) {
        engine.setNodeStatus(nodeId, status as NodeStatus);
      }
      if (tool) {
        engine.setNodeTool(nodeId, tool);
      }
    });

    // Snapshot initial plan hash
    lastPlanHashRef.current = getExecutionPlanHash(engine.state.nodes, engine.state.connections);
  }, [state.detailPanelData, engine]);

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

  const hasNodes = engine.state.nodes.size > 0;
  const [isPopout, setIsPopout] = useState(false);

  if (!hasNodes) {
    return (
      <div className="detail-empty-state">
        <p>{t('empty.graph_hint')}</p>
      </div>
    );
  }

  return (
    <div className="graph-tab-wrapper">
      <div className="graph-tab-header">
        <span className="graph-tab-label">{t('graph.editor_title')}</span>
        <div className="graph-tab-header-actions">
          <button className="graph-popout-btn" onClick={() => setIsPopout(true)} title={t('tooltip.popout')}>
            ⇗
          </button>
          <button className="graph-rerun-btn" onClick={handleRerunPlan}>
            {t('graph.rerun')}
          </button>
        </div>
      </div>
      {isPopout ? (
        <>
          <GraphPopout onClose={() => setIsPopout(false)}>
            <GraphCanvas engine={engine} />
          </GraphPopout>
          <div className="graph-popout-notice">
            <span>{t('empty.graph_popout') || 'Graph is open in a separate window'}</span>
            <button onClick={() => setIsPopout(false)}>{t('label.close') || 'Close'}</button>
          </div>
        </>
      ) : (
        <GraphCanvas engine={engine} />
      )}
    </div>
  );
}
