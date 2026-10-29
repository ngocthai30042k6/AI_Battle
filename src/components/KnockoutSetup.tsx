import React, { useMemo, useState } from 'react';
import { Swords } from 'lucide-react';
import { TournamentCustomization, type TournamentCustomizationValue } from './TournamentCustomization';

export type KnockoutSetupPayload = TournamentCustomizationValue & { pairings: string[][]; knockoutStartsAt: string };

export function KnockoutSetup({ groups, rules, submitting, onStart }: {
  groups: any[];
  rules: any;
  submitting: boolean;
  onStart: (payload: KnockoutSetupPayload) => void;
}) {
  const qualifiers = useMemo(() => groups.flatMap(group => (group.standings || []).slice(0, 2)), [groups]);
  const [settings, setSettings] = useState<TournamentCustomizationValue>({
    blockedCells: rules?.blockedCells || [], moveLimitRule: rules?.moveLimitRule || 'standard',
    capturedPieceValues: rules?.capturedPieceValues || { rock: 1, paper: 2, scissors: 3 },
  });
  const [startsAt, setStartsAt] = useState(() => {
    const date = new Date(Date.now() + 60 * 60000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [seats, setSeats] = useState<string[]>(() => {
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
  return (
    <section className="space-y-4 rounded-2xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-5">
      <div>
        <h3 className="font-bold">Vòng bảng đã kết thúc · Thiết lập Knock-out BO3</h3>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
          Thắng 1 điểm, hòa 0,5 điểm. Tối đa 3 ván chính; thắng hai ván đầu dừng ở 2–0.
          Bằng điểm sau 3 ván thì đấu ván phụ đến khi phân thắng bại. Ván đầu chọn người đi trước ngẫu nhiên;
          từ ván sau bên thua đi trước, sau ván hòa đổi bên. Công bố nhánh và luật trước để người chơi sửa Bot;
          đến giờ BTC bấm khởi chạy, server mới chốt Bot và tự chạy các vòng.
        </p>
      </div>
      <fieldset disabled={submitting} className="space-y-4 disabled:opacity-60">
        <TournamentCustomization value={settings} onChange={setSettings} />
        <label className="block text-xs text-[var(--text-secondary)]">
          <span className="mb-2 block font-semibold">Thời gian bắt đầu vòng Knock-out (giờ trên thiết bị của bạn)</span>
          <input type="datetime-local" required value={startsAt} onChange={e => setStartsAt(e.target.value)}
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-white [color-scheme:dark]" />
          <span className="mt-2 block text-[var(--text-muted)]">Người chơi có thể lưu phiên bản Bot mới trước khi BTC khởi chạy.</span>
        </label>
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
          <button type="button" disabled={submitting || !seats.length || seats.length !== qualifiers.length || !startsAt}
            onClick={() => onStart({ ...settings, knockoutStartsAt: new Date(startsAt).toISOString(), pairings: Array.from({ length: seats.length / 2 }, (_, i) => seats.slice(i * 2, i * 2 + 2)) })}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
            <Swords className="h-4 w-4" />{submitting ? 'Đang phân nhánh…' : 'Phân nhánh và công bố Knock-out BO3'}
          </button>
        </div>
      </fieldset>
    </section>
  );
}
