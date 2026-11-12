import { useEffect, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { testPhoneDigits } from './smsTextTemplateFormModel.js';

// 문자 템플릿 화면 맨 아래 접힘 줄: 수신거부 번호(끝 4자리만 보인다). 자동 발송은 이 번호를 건너뛴다.
export default function SmsOptoutRow({ active }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetchSmsConsole('optouts').then((res) => setItems(Array.isArray(res?.items) ? res.items : [])).catch(() => {});
  useEffect(() => { if (active) load(); }, [active]);

  const add = async () => {
    const digits = testPhoneDigits(phone);
    if (busy) return;
    if (!digits) { setError('010 으로 시작하는 번호를 넣어 주세요.'); return; }
    setBusy(true); setError('');
    try { await postSmsConsole('optout_add', { phone: digits }); setPhone(''); await load(); } catch (err) { setError(err.message || '추가하지 못했습니다.'); } finally { setBusy(false); }
  };
  const remove = async (item) => {
    if (confirmId !== item.id) { setConfirmId(item.id); return; }
    setError('');
    try { await postSmsConsole('optout_delete', { id: item.id }); setConfirmId(''); await load(); } catch (err) { setError(err.message || '지우지 못했습니다.'); }
  };

  return (
    <section className="sac-optout" aria-label="수신거부 번호">
      <button type="button" className="ktm-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>수신거부 번호 {items.length}</button>
      {open ? (
        <div className="sac-optout-body">
          <div className="sac-test">
            <input type="text" inputMode="tel" value={phone} maxLength={13} autoComplete="off" aria-label="수신거부 번호" onChange={(event) => setPhone(event.target.value)} />
            <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={add}>추가</button>
          </div>
          <ul className="sac-optout-list">
            {items.map((item) => (
              <li key={item.id}>
                <span>***{item.last4 || item.phone_last4} · {item.created_at ? new Date(item.created_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : ''}</span>
                <button type="button" className="ktm-btn" onClick={() => remove(item)}>{confirmId === item.id ? '삭제 확인' : '삭제'}</button>
              </li>
            ))}
          </ul>
          {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
