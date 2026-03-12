// ============================================
// Connection Status Indicator
// Shows SGLang/DB connection health in bottom-right
// ============================================

import { useState, useEffect, useRef } from 'react';
import { fetchHealth } from '@/api/client';
import type { HealthStatus } from '@/api/client';
import { useAppContext } from '@/context/AppContext';

const POLL_INTERVAL = 30_000; // 30 seconds

export function ConnectionStatus() {
  const { state } = useAppContext();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    const check = async () => {
      try {
        const h = await fetchHealth();
        setHealth(h);
      } catch {
        setHealth({ status: 'error', sglang: false, db: false });
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, []);

  if (!health) return null;

  // 현재 선택된 모델이 커스텀(로컬) 모델인지 확인합니다.
  const isLocalModel = state.currentModel?.type === 'local';

  // DB는 항상 정상이어야 하고, SGLang은 로컬 모델을 사용할 때만 정상이면 됩니다.
  const allOk = health.db && (!isLocalModel || health.sglang);
  
  const issues: string[] = [];
  // 로컬 모델인데 SGLang이 죽어있을 때만 이슈 목록에 추가
  if (isLocalModel && !health.sglang) issues.push('SGLang');
  // DB 이슈는 항상 체크
  if (!health.db) issues.push('Database');

  return (
    <div
      className={`connection-status ${allOk ? 'ok' : 'error'}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span className={`connection-dot ${allOk ? 'ok' : 'error'}`} />
      {!allOk && (
        <span className="connection-label">
          {issues.join(', ')} disconnected
        </span>
      )}
      {showTooltip && (
        <div className="connection-tooltip">
          {/* 로컬 모델일 때만 SGLang 상태 행을 툴팁에 렌더링합니다. */}
          {isLocalModel && (
            <div className={`connection-tooltip-row ${health.sglang ? 'ok' : 'error'}`}>
              <span className={`connection-dot-sm ${health.sglang ? 'ok' : 'error'}`} />
              SGLang: {health.sglang ? 'Connected' : 'Disconnected'}
            </div>
          )}
          <div className={`connection-tooltip-row ${health.db ? 'ok' : 'error'}`}>
            <span className={`connection-dot-sm ${health.db ? 'ok' : 'error'}`} />
            Database: {health.db ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      )}
    </div>
  );
}