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
        <div className="detail-tab-content" style={{ display: activeTab === 'plan' ? 'flex' : 'none', flexDirection: 'column' as const, height: '100%', overflow: 'hidden' }}><PlanTab /></div>
        <div className="detail-tab-content" style={{ display: activeTab === 'graph' ? 'flex' : 'none', flexDirection: 'column' as const, height: '100%', overflow: 'hidden', padding: 0 }}><GraphTab /></div>
        <div className="detail-tab-content" style={{ display: activeTab === 'code' ? 'flex' : 'none', flexDirection: 'column' as const, height: '100%', overflow: 'hidden' }}><CodeTab /></div>
        <div className="detail-tab-content" style={{ display: activeTab === 'outputs' ? 'flex' : 'none', flexDirection: 'column' as const, height: '100%', overflow: 'hidden' }}><OutputsTab /></div>
      </div>
    </div>
  );
}
