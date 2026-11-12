import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { buildConsoleQuery, parseConsoleQuery } from '../../shared/smsConsole.js';
import { normalizeKind } from '../components/smsconsole/smsTextTemplateFormModel.js';
import SmsConsoleSidebar from '../components/smsconsole/SmsConsoleSidebar';
import CustomerSmsPanel from '../components/CustomerSmsPanel';
import NotificationOverview from '../components/NotificationOverview';
import SolapiMessageLog from '../components/SolapiMessageLog';
import SmsCampaignManager from '../components/SmsCampaignManager';
import StaffSmsPanel from '../components/StaffSmsPanel';
import './SmsHistoryPage.css';

const SmsDashboard = lazy(() => import('../components/smsconsole/SmsDashboard.jsx'));
const SendPanel = lazy(() => import('../components/smsconsole/SendPanel.jsx'));
const KakaoTemplateManager = lazy(() => import('../components/smsconsole/KakaoTemplateManager.jsx'));
const SmsTemplateList = lazy(() => import('../components/smsconsole/SmsTemplateList.jsx'));
const CONSOLE_QUERY_KEYS = ['menu', 'aud', 'ch', 'tpl', 'mode', 'template', 'kind', 'text'];
const PANE_LOADING = <p className="sms-console-loading" role="status">불러오는 중…</p>;

export default function SmsHistoryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseConsoleQuery(searchParams), [searchParams]);
  const [visited, setVisited] = useState(() => new Set([state.menu]));
  const [logPreset, setLogPreset] = useState(null);
  // 문자 관리 도구는 고객·직원 메뉴가 함께 쓰는 한 개라, 다른 메뉴에 가 있는 동안에는 마지막 대상을 유지한다
  // (직원 → 발송 내역 → 직원으로 오갈 때 숨은 도구가 고객 기준으로 다시 불러오지 않게)
  const lastAudienceRef = useRef(state.menu === 'staff' ? 'employee' : 'customer');
  if (state.menu === 'staff') lastAudienceRef.current = 'employee';
  else if (state.menu === 'customer') lastAudienceRef.current = 'customer';
  const audience = lastAudienceRef.current;
  const [activePanel, setActivePanel] = useState('history');
  const [customerPanel, setCustomerPanel] = useState('history');

  // 템플릿 메뉴의 문자·알림톡 화면은 처음 열 때 한 번만 그리고, 오갈 때는 숨기기만 한다(재조회 방지)
  const [tplSeen, setTplSeen] = useState({ sms: false, kakao: false });
  const tplKind = state.ch === 'sms' ? 'sms' : 'kakao';
  useEffect(() => {
    if (state.menu !== 'templates') return;
    setTplSeen(prev => (prev[tplKind] ? prev : { ...prev, [tplKind]: true }));
  }, [state.menu, tplKind]);

  useEffect(() => {
    setVisited(prev => (prev.has(state.menu) ? prev : new Set(prev).add(state.menu)));
  }, [state.menu]);
  const isMounted = menu => visited.has(menu) || state.menu === menu;

  // 콘솔 5개 키만 바꾸고 다른 쿼리 키는 그대로 둔다. 메뉴 이동은 push, 화면 안 필터는 replace.
  const writeState = useCallback((next, replace) => {
    const params = new URLSearchParams(searchParams);
    CONSOLE_QUERY_KEYS.forEach(key => params.delete(key));
    new URLSearchParams(buildConsoleQuery(next)).forEach((value, key) => params.set(key, value));
    // 문자 템플릿 등록의 종류(kind)와 보내기에 채울 내 문구(text)는 콘솔 상태 밖의 칸이라 여기서 따로 붙인다
    if (next.menu === 'templates' && next.mode === 'new' && next.kind) params.set('kind', normalizeKind(next.kind));
    if (next.menu === 'send' && /^\d{1,12}$/.test(String(next.text || ''))) params.set('text', String(next.text));
    setSearchParams(params, { replace });
  }, [searchParams, setSearchParams]);

  const selectMenu = useCallback((menu, patch = {}) => {
    writeState({ aud: 'all', ch: 'all', tpl: '', mode: '', ...patch, menu }, false);
  }, [writeState]);
  const kind = normalizeKind(searchParams.get('kind'));
  const textId = state.menu === 'send' && /^\d{1,12}$/.test(searchParams.get('text') || '') ? searchParams.get('text') : '';
  const patchState = useCallback(patch => {
    // 종류 고르기를 바꾸는 요청이 아닌 동안(새 등록 화면 안에서 다른 칸이 바뀔 때)에는 지금 종류를 유지한다
    writeState({ ...state, ...(state.mode === 'new' && patch.mode !== '' ? { kind } : {}), ...patch }, true);
  }, [state, kind, writeState]);
  const openLog = useCallback(templateId => {
    setLogPreset({ key: Date.now(), view: 'messages', filters: { template_id: templateId } });
    writeState({ aud: 'all', ch: 'all', tpl: '', mode: '', menu: 'log' }, false);
  }, [writeState]);

  return (
    <div className="sms-history-page">
      <header className="sms-history-header">
        <div className="sms-history-header__inner">
          <button
            type="button"
            className="sms-history-back"
            onClick={() => navigate('/')}
            aria-label="홈으로 돌아가기"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div>
            <p className="sms-history-eyebrow">자동문자 운영 현황</p>
            <h1>문자 관리</h1>
          </div>
        </div>
      </header>

      <main className="sms-history-main sms-console">
        <SmsConsoleSidebar state={state} onSelect={selectMenu} />

        <div className="sms-console-content">
        {isMounted('dashboard') && (
          <div className="sms-console-pane" hidden={state.menu !== 'dashboard'}>
            <Suspense fallback={PANE_LOADING}>
              <SmsDashboard active={state.menu === 'dashboard'} onNavigate={selectMenu} />
            </Suspense>
          </div>
        )}

        {isMounted('send') && (
          <div className="sms-console-pane" hidden={state.menu !== 'send'}>
            <Suspense fallback={PANE_LOADING}>
              <SendPanel active={state.menu === 'send'} template={state.template || ''} text={textId} />
            </Suspense>
          </div>
        )}

        {isMounted('log') && (
          <div
            className="sms-console-pane"
            id="sms-history-audience-panel-solapi"
            hidden={state.menu !== 'log'}
          >
            <SolapiMessageLog
              audience={state.aud}
              channel={state.ch}
              onAudienceChange={aud => patchState({ aud })}
              onChannelChange={ch => patchState({ ch })}
              preset={logPreset}
            />
          </div>
        )}

        {isMounted('templates') && (
          <div className="sms-console-pane" hidden={state.menu !== 'templates'}>
            <Suspense fallback={PANE_LOADING}>
              {(tplSeen.sms || tplKind === 'sms') && (
                <div hidden={tplKind !== 'sms'}>
                  <SmsTemplateList active={state.menu === 'templates' && tplKind === 'sms'} onSendText={id => selectMenu('send', { text: id })} />
                </div>
              )}
              {(tplSeen.kakao || tplKind === 'kakao') && (
                <div hidden={tplKind !== 'kakao'}>
                  <KakaoTemplateManager
                    active={state.menu === 'templates' && tplKind === 'kakao'}
                    selectedId={tplKind === 'kakao' ? state.tpl : ''}
                    mode={tplKind === 'kakao' ? state.mode : ''}
                    kind={kind}
                    onSendText={id => selectMenu('send', { text: id })}
                    onRoute={patchState}
                    onSend={id => selectMenu('send', { template: id })}
                    onOpenLog={openLog}
                  />
                </div>
              )}
            </Suspense>
          </div>
        )}

        {(isMounted('customer') || isMounted('staff')) && (
          <div className="sms-console-campaign" hidden={state.menu !== 'customer' && state.menu !== 'staff'}>
            <SmsCampaignManager audience={audience} />
          </div>
        )}

        {isMounted('customer') && (
          <div
            className="sms-console-pane sms-console-pane--fill"
            id="sms-history-audience-panel-customer"
            hidden={state.menu !== 'customer'}
          >
            <div className="sms-history-view-tabs" role="tablist" aria-label="고객 문자 보기">
              <button
                type="button"
                role="tab"
                id="sms-history-customer-tab-history"
                aria-selected={customerPanel === 'history'}
                aria-controls="sms-history-customer-panel-history"
                onClick={() => setCustomerPanel('history')}
              >
                발송 내역
              </button>
              <button
                type="button"
                role="tab"
                id="sms-history-customer-tab-overview"
                aria-selected={customerPanel === 'overview'}
                aria-controls="sms-history-customer-panel-overview"
                onClick={() => setCustomerPanel('overview')}
              >
                등록 현황
              </button>
            </div>
            <div className="sms-history-workspace">
              <section
                className={`sms-history-workspace-panel sms-history-workspace-panel--overview ${customerPanel === 'overview' ? 'is-active' : ''}`}
                id="sms-history-customer-panel-overview"
                role="tabpanel"
                aria-labelledby="sms-history-customer-tab-overview"
              >
                <NotificationOverview group="customer" />
              </section>
              <section
                className={`sms-history-workspace-panel sms-history-workspace-panel--history ${customerPanel === 'history' ? 'is-active' : ''}`}
                id="sms-history-customer-panel-history"
                role="tabpanel"
                aria-labelledby="sms-history-customer-tab-history"
              >
                <CustomerSmsPanel />
              </section>
            </div>
          </div>
        )}

        {isMounted('staff') && (
        <div
          className="sms-console-pane sms-console-pane--fill sms-history-employee-panel"
          id="sms-history-audience-panel-employee"
          hidden={state.menu !== 'staff'}
        >
        <div className="sms-history-view-tabs" role="tablist" aria-label="문자 현황 보기">
          <button
            type="button"
            role="tab"
            id="sms-history-tab-history"
            aria-selected={activePanel === 'history'}
            aria-controls="sms-history-panel-history"
            onClick={() => setActivePanel('history')}
          >
            발송 내역
          </button>
          <button
            type="button"
            role="tab"
            id="sms-history-tab-overview"
            aria-selected={activePanel === 'overview'}
            aria-controls="sms-history-panel-overview"
            onClick={() => setActivePanel('overview')}
          >
            등록 현황
          </button>
        </div>

        <div className="sms-history-workspace">
          <section
            className={`sms-history-workspace-panel sms-history-workspace-panel--overview ${activePanel === 'overview' ? 'is-active' : ''}`}
            id="sms-history-panel-overview"
            role="tabpanel"
            aria-labelledby="sms-history-tab-overview"
            data-sms-panel="overview"
          >
            <NotificationOverview group="internal" />
          </section>

          <section
            className={`sms-history-workspace-panel sms-history-workspace-panel--history ${activePanel === 'history' ? 'is-active' : ''}`}
            id="sms-history-panel-history"
            role="tabpanel"
            aria-labelledby="sms-history-tab-history"
            data-sms-panel="history"
          >
            <StaffSmsPanel active={state.menu === 'staff'} />
          </section>
        </div>
        </div>
        )}
        </div>
      </main>
    </div>
  );
}
