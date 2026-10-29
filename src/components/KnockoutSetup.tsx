import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Swords, X } from 'lucide-react';
import { TournamentCustomization, type TournamentCustomizationValue } from './TournamentCustomization';
import { DateTimePicker } from './DateTimePicker';
import { addScheduleTime, deviceTimeZoneLabel, localDateTimeValue, parseLocalDateTime } from '../core/tournamentSchedule';

export type KnockoutSetupPayload = TournamentCustomizationValue & { pairings: string[][]; knockoutStartsAt: string };

export function KnockoutSetup({ groups, rules, fixtures = [], startsAt: scheduledStart, submitting, onStart, onClose }: {
  groups: any[];
  rules: any;
  fixtures?: any[];
  startsAt?: string;
  submitting: boolean;
  onStart: (payload: KnockoutSetupPayload) => Promise<boolean>;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose), submittingRef = useRef(submitting);
  closeRef.current = onClose; submittingRef.current = submitting;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submittingRef.current) closeRef.current(); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  const qualifiers = useMemo(() => groups.flatMap(group => (group.standings || []).slice(0, 2)), [groups]);
  const [settings, setSettings] = useState<TournamentCustomizationValue>({
    blockedCells: rules?.blockedCells || [], moveLimitRule: rules?.moveLimitRule || 'standard',
    capturedPieceValues: rules?.capturedPieceValues || { rock: 1, paper: 2, scissors: 3 },
  });
  const [startsAt, setStartsAt] = useState(() => {
    const date = scheduledStart ? new Date(scheduledStart) : new Date(Date.now() + 60 * 60000);
    return localDateTimeValue(date);
  });
  const [seats, setSeats] = useState<string[]>(() => {
    if (fixtures.length) return [...fixtures].sort((a,b) => a.match_number-b.match_number).flatMap(f => [f.player1_id,f.player2_id]);
    const pairs: string[] = [];
    for (let i = 0; i < groups.length; i += 2) {
      const a = groups[i].standings || [], b = groups[i + 1]?.standings || [];
      if (a.length >= 2 && b.length >= 2) pairs.push(a[0].player_id, b[1].player_id, b[0].player_id, a[1].player_id);
    }
    return pairs;
  });
  function chooseSeat(index: number, id: string) {
    // Swap slots so no qualifier is accidentally duplicated or omitted.
    setSeats(current => {
      const updated = [...current], other = updated.indexOf(id);
      if (other < 0) return current;
      [updated[index], updated[other]] = [updated[other], updated[index]];
      return updated;
    });
  }
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm sm:items-center"
      onClick={event => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="knockout-setup-heading"
      className="my-auto w-full max-w-4xl space-y-5 rounded-2xl border border-[var(--border-accent)] bg-[#150e23] p-5 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <h2 id="knockout-setup-heading" className="text-xl font-bold">Điều chỉnh vòng Knock Out</h2>
        <button type="button" autoFocus disabled={submitting} onClick={onClose} aria-label="Đóng điều chỉnh Knock Out"
          className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-white/10"><X className="h-5 w-5" /></button>
      </div>
      <div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          Thắng 1 điểm, hòa 0,5 điểm. Tối đa 3 ván chính; thắng hai ván đầu dừng ở 2–0.
          Bằng điểm sau 3 ván thì đấu ván phụ đến khi phân thắng bại. Ván đầu chọn người đi trước ngẫu nhiên;
          từ ván sau bên thua đi trước, sau ván hòa đổi bên. Công bố nhánh và luật trước để người chơi sửa Bot;
          đến giờ BTC bấm khởi chạy, server mới chốt Bot và tự chạy các vòng.
        </p>
      </div>
      <fieldset disabled={submitting} className="space-y-4 disabled:opacity-60">
        <TournamentCustomization value={settings} onChange={setSettings} />
        <div className="max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4 text-xs text-[var(--text-secondary)]">
          <h3 className="mb-1 font-semibold">Thời gian bắt đầu vòng Knock-Out</h3>
          <p className="mb-3 text-[10px] text-[var(--text-muted)]">{deviceTimeZoneLabel()} · Định dạng 24 giờ</p>
          <DateTimePicker label="Bắt đầu Knock-Out" value={startsAt} onChange={setStartsAt}
            error={parseLocalDateTime(startsAt) ? '' : 'Chọn đầy đủ ngày và giờ bắt đầu Knock-Out.'}
            shortcuts={[{label:'Sau 30 phút',value:()=>addScheduleTime(localDateTimeValue(new Date()),0,30)},{label:'Sau 1 giờ',value:()=>addScheduleTime(localDateTimeValue(new Date()),0,60)}]} />
          <span className="mt-2 block text-[var(--text-muted)]">Người chơi có thể lưu phiên bản Bot mới trước khi BTC khởi chạy.</span>
        </div>
        <details className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-4">
          <summary className="cursor-pointer text-sm font-semibold">Điều chỉnh các cặp knock-out · {seats.length / 2} cặp</summary>
          <p className="my-3 text-xs text-[var(--text-muted)]">Chọn đấu thủ để hoán đổi vị trí. Mỗi người nhất/nhì bảng xuất hiện đúng một lần; các vòng sau ghép theo thứ tự nhánh.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: seats.length / 2 }, (_, pair) => (
              <div key={pair} className="rounded-lg border border-[var(--border-subtle)] p-3">
                <p className="mb-2 text-xs font-semibold text-[var(--accent-primary)]">Cặp {pair + 1} · BO3</p>
                <div className="space-y-2">
                  {[pair * 2, pair * 2 + 1].map(index => (
                    <select key={index} aria-label={`Cặp ${pair + 1}, đấu thủ ${index % 2 + 1}`} value={seats[index]}
                      onChange={event => chooseSeat(index, event.target.value)}
                      className="w-full min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[#150e23] px-3 py-2 text-xs">
                      {qualifiers.map(player => <option key={player.player_id} value={player.player_id}>
                        {player.display_name} · Bảng {player.group_number}
                      </option>)}
                    </select>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
        <div className="flex justify-end">
          <button type="button" disabled={submitting || !seats.length || seats.length !== qualifiers.length || !parseLocalDateTime(startsAt)}
            onClick={async () => {
              if (await onStart({ ...settings, knockoutStartsAt: new Date(startsAt).toISOString(), pairings: Array.from({ length: seats.length / 2 }, (_, i) => seats.slice(i * 2, i * 2 + 2)) })) onClose();
            }}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
            <Swords className="h-4 w-4" />{submitting ? 'Đang phân nhánh…' : 'Phân nhánh và công bố Knock-out BO3'}
          </button>
        </div>
      </fieldset>
    </section>
    </div>, document.body
  );
}
