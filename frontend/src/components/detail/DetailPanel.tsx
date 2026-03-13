import { useEffect, useRef } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useTranslation } from '@/i18n';
import { PlanTab } from './PlanTab';
import { GraphTab } from './GraphTab';
import { CodeTab } from './CodeTab';
import { OutputsTab } from './OutputsTab';

export function DetailPanel() {
  const { state, dispatch } = useAppContext();
  const { t } = useTranslation();
  const activeTab = state.activeDetailTab;
  const prevStepsLengthRef = useRef(0);

  useEffect(() => {
    const currentStepsLength = state.detailPanelData?.steps?.length || 0;
    // 이전에 step이 없다가 새롭게 생성된 경우
    if (currentStepsLength > 0 && prevStepsLengthRef.current === 0) {
      dispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'graph' });
    }
    prevStepsLengthRef.current = currentStepsLength;
  }, [state.detailPanelData?.steps, dispatch]);

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <div className="detail-tabs">
          <button
            className={`detail-tab ${activeTab === 'plan' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'plan' })}
          >
            {t('label.tab_plan')}
          </button>
          <button
            className={`detail-tab ${activeTab === 'graph' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'graph' })}
          >
            {t('label.tab_graph')}
          </button>
          <button
            className={`detail-tab ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'code' })}
          >
            {t('label.tab_code')}
          </button>
          <button
            className={`detail-tab ${activeTab === 'outputs' ? 'active' : ''}`}
            onClick={() => dispatch({ type: 'SET_ACTIVE_DETAIL_TAB', payload: 'outputs' })}
          >
            {t('label.tab_outputs')}
          </button>
        </div>
      </div>

      <div className="detail-content">
        {activeTab === 'plan' && <PlanTab />}
        {activeTab === 'graph' && <GraphTab />}
        {activeTab === 'code' && <CodeTab />}
        {activeTab === 'outputs' && <OutputsTab />}
      </div>
    </div>
  );
}
