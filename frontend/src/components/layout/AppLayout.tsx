import { useRef, useEffect, useCallback } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { ChatArea } from '@/components/chat/ChatArea';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { DetailPanel } from '@/components/detail/DetailPanel';
import { ModalContainer } from '@/components/common/ModalContainer';
import { ToastContainer } from '@/components/common/Toast';
import { ConnectionStatus } from '@/components/common/ConnectionStatus';
import { useAppContext } from '@/context/AppContext';
import { useDetailResize } from '@/hooks/useDetailResize';
import { useTranslation } from '@/i18n';

export function AppLayout() {
  const { state, dispatch } = useAppContext();
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleWidthChange = useCallback((width: number) => {
    dispatch({ type: 'SET_DETAIL_PANEL_WIDTH', payload: String(Math.round(width)) });
  }, [dispatch]);

  const { handleMouseDown } = useDetailResize(containerRef, () => {
    dispatch({ type: 'TOGGLE_DETAIL_PANEL' });
  }, handleWidthChange);

  // Restore saved panel width when panel opens
  useEffect(() => {
    if (state.detailPanelOpen && state.detailPanelWidth && containerRef.current) {
      containerRef.current.style.setProperty('--detail-panel-width', `${state.detailPanelWidth}px`);
    }
  }, [state.detailPanelOpen, state.detailPanelWidth]);

  return (
    <div className="app-container">
      <div className="background-layer" id="backgroundLayer" />
      <Sidebar />
      <main className="main-content">
        <ChatHeader />
        <div className="chat-detail-container" ref={containerRef}>
          <ChatArea />
          <button
            className={`detail-toggle ${state.detailPanelOpen ? 'panel-open' : ''}`}
            onClick={() => dispatch({ type: 'TOGGLE_DETAIL_PANEL' })}
            title={t('tooltip.toggle_detail')}
          >
            <ChevronLeft size={16} />
          </button>
          {state.detailPanelOpen && (
            <>
              <div
                className="detail-resize-handle"
                onMouseDown={handleMouseDown}
              />
              <DetailPanel />
            </>
          )}
        </div>
      </main>
      <ModalContainer />
      <ToastContainer />
      <ConnectionStatus />
    </div>
  );
}
