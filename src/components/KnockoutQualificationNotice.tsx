import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trophy, X } from 'lucide-react';
import { backendClient } from '../core/backendClient';
import { knockoutNoticeKey, localCalendarDay } from '../core/knockoutPresentation';

export function KnockoutQualificationNotice({ userId, onOpenTournament }: {
  userId?: string; onOpenTournament: (id: string) => void;
}) {
  const [notices, setNotices] = useState<Array<{id: string; name: string; knockout_starts_at?: string}>>([]);
  const [hideToday, setHideToday] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setNotices([]); setHideToday(false);
    if (!userId) return;
    void backendClient.getKnockoutNotices().then(items => {
      if (cancelled) return;
      setNotices(items.filter(item => {
        try { return localStorage.getItem(knockoutNoticeKey(userId, item.id)) !== localCalendarDay(); }
        catch { return true; }
      }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);
  const current = notices[0];
  if (!userId || !current) return null;
  const dismiss = () => {
    if (hideToday) {
      try { localStorage.setItem(knockoutNoticeKey(userId, current.id), localCalendarDay()); } catch { /* unavailable storage */ }
    }
    setNotices(items => items.slice(1)); setHideToday(false);
  };
  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="knockout-notice-title" className="relative w-full max-w-xl rounded-2xl border border-orange-400/40 bg-[var(--bg-elevated)] p-6 shadow-2xl sm:p-8">
        <button autoFocus type="button" onClick={dismiss} aria-label="Đóng thông báo Knock-Out" className="absolute right-4 top-4 rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><X className="h-5 w-5" /></button>
        <Trophy className="mb-4 h-12 w-12 text-yellow-400" />
        <p className="mb-2 text-sm font-bold text-[var(--accent-primary)]">{current.name}</p>
        <h2 id="knockout-notice-title" className="pr-5 text-2xl font-black text-[var(--text-primary)]">Chúc mừng bạn đã vượt qua vòng bảng</h2>
        <p className="mt-4 text-base leading-7 text-[var(--text-secondary)]">Hãy chú ý luật chơi, thời gian thi đấu của vòng Knock-Out !!! Bạn có thể thay đổi Bot của mình để tiếp tục chiến đấu !!!</p>
        {current.knockout_starts_at && <p className="mt-3 text-sm font-semibold text-[var(--accent-primary)]">Bắt đầu Knock-Out: {new Date(current.knockout_starts_at).toLocaleString('vi-VN')}</p>}
        <label className="mt-6 flex cursor-pointer items-center gap-3 text-sm text-[var(--text-secondary)]"><input type="checkbox" checked={hideToday} onChange={event => setHideToday(event.target.checked)} className="h-4 w-4 accent-orange-500" />Không hiển thị lại trong ngày hôm nay</label>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" onClick={dismiss} className="rounded-xl border border-[var(--border-subtle)] px-4 py-2.5 text-sm font-semibold">Đã hiểu</button>
          <button type="button" onClick={() => { onOpenTournament(current.id); dismiss(); }} className="rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-bold text-white">Xem vòng Knock-Out</button>
        </div>
      </section>
    </div>, document.body);
}
