import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, X } from 'lucide-react';

export function TournamentEligibilityDialog({ minimum, elo, onClose }: {
  minimum: number; elo?: number; onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="tournament-eligibility-heading"
        aria-describedby="tournament-eligibility-message"
        className="w-full max-w-md rounded-2xl border border-[var(--border-accent)] bg-[#150e23] p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 id="tournament-eligibility-heading" className="flex items-center gap-2 text-lg font-bold">
            <AlertCircle className="h-5 w-5 text-[var(--accent-primary)]" />Điều kiện đăng ký
          </h2>
          <button type="button" onClick={onClose} aria-label="Đóng thông báo" className="rounded-lg p-2 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <p id="tournament-eligibility-message" className="mt-4 text-sm leading-relaxed">Giải đấu yêu cầu Elo từ {minimum} trở lên.</p>
        {elo != null && <p className="mt-2 text-xs text-[var(--text-secondary)]">Elo hiện tại của bạn: {elo}.</p>}
        <div className="mt-6 flex justify-end"><button type="button" autoFocus onClick={onClose}
          className="rounded-xl bg-[var(--accent-primary)] px-5 py-2.5 text-sm font-semibold text-white">Đã hiểu</button></div>
      </section>
    </div>, document.body
  );
}
