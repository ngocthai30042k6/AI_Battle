import React, { useState } from 'react';
import { CalendarDays, CheckCircle2, Clock3, X } from 'lucide-react';
import { TournamentCustomization } from './TournamentCustomization';
import { DateTimePicker } from './DateTimePicker';
import { addScheduleTime, deviceTimeZoneLabel, localDateTimeValue, parseLocalDateTime, scheduleDuration, scheduleErrors } from '../core/tournamentSchedule';

export interface TournamentCreatePayload {
  minElo: number;
  name: string;
  description: string;
  registrationOpensAt: string;
  registrationClosesAt: string;
  tournamentStartsAt: string;
  blockedCells: number[];
  moveLimitRule: 'standard' | 'remaining-pieces' | 'goal-distance' | 'captured-points';
  capturedPieceValues: { rock: number; paper: number; scissors: number };
}

interface TournamentCreationModalProps {
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: TournamentCreatePayload) => Promise<void>;
}

export const TournamentCreationModal: React.FC<TournamentCreationModalProps> = ({
  submitting,
  onClose,
  onSubmit,
}) => {
  const now = new Date();
  const [name, setName] = useState('');
  const [minElo, setMinElo] = useState(0);
  const [description, setDescription] = useState('');
  const [registrationOpensAt, setRegistrationOpensAt] = useState(localDateTimeValue(now));
  const [registrationClosesAt, setRegistrationClosesAt] = useState(
    localDateTimeValue(new Date(now.getTime() + 3 * 86400000))
  );
  const [tournamentStartsAt, setTournamentStartsAt] = useState(
    localDateTimeValue(new Date(now.getTime() + 4 * 86400000))
  );
  const [blockedCells, setBlockedCells] = useState<number[]>([]);
  const [moveLimitRule, setMoveLimitRule] = useState<
    'standard' | 'remaining-pieces' | 'goal-distance' | 'captured-points'
  >(
    'standard'
  );
  const [capturedPieceValues, setCapturedPieceValues] = useState({
    rock: 1,
    paper: 2,
    scissors: 3,
  });
  const [formError, setFormError] = useState('');
  const errors = scheduleErrors(registrationOpensAt, registrationClosesAt, tournamentStartsAt);
  const validSchedule = !Object.values(errors).some(Boolean);
  const applyPreset = (days: number) => {
    const opens = parseLocalDateTime(registrationOpensAt) ? registrationOpensAt : localDateTimeValue(new Date());
    const closes = addScheduleTime(opens, days);
    setRegistrationOpensAt(opens);
    setRegistrationClosesAt(closes);
    setTournamentStartsAt(addScheduleTime(closes, 0, 60));
    setFormError('');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const opens = parseLocalDateTime(registrationOpensAt);
    const closes = parseLocalDateTime(registrationClosesAt);
    const starts = parseLocalDateTime(tournamentStartsAt);
    if (!validSchedule || !opens || !closes || !starts) {
      setFormError('Kiểm tra lại các mốc thời gian được đánh dấu.');
      return;
    }
    setFormError('');
    try { await onSubmit({
      minElo,
      name,
      description,
      registrationOpensAt: opens.toISOString(),
      registrationClosesAt: closes.toISOString(),
      tournamentStartsAt: starts.toISOString(),
      blockedCells,
      moveLimitRule,
      capturedPieceValues,
    }); } catch (error: any) { setFormError(error.message || 'Không thể tạo giải. Vui lòng thử lại.'); }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-5"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-tournament-heading"
        className="flex max-h-[94dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--border-accent)] bg-[#150e23] shadow-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--border-subtle)] p-5 sm:p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent-primary)]">
              Ban Tổ Chức
            </p>
            <h2 id="create-tournament-heading" className="mt-1 text-xl font-bold">
              Tạo giải vòng bảng + knock-out
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Mỗi tài khoản đăng ký một đấu thủ; sau khi đóng đăng ký, BTC chia 8, 16 hoặc 32 bảng.
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 space-y-5 overflow-y-auto p-5 sm:p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="md:col-span-2">
              <span className="mb-1 block text-xs text-[var(--text-secondary)]">Elo tối thiểu để đăng ký giải</span>
              <input type="number" min={0} max={10000} step={1} required value={minElo}
                onChange={event => setMinElo(Number(event.target.value))}
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3.5 py-2.5 text-sm text-white" />
              <span className="mt-1 block text-xs text-[var(--text-muted)]">0 = không giới hạn. Người chơi cần Elo lớn hơn hoặc bằng mức này.</span>
            </label>
            <label className="md:col-span-2">
              <span className="mb-1 block text-xs text-[var(--text-secondary)]">Tên giải đấu</span>
              <input
                autoFocus
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3.5 py-2.5 text-sm text-white focus:border-[var(--accent-primary)] focus:outline-none"
                placeholder="Ví dụ: OTTv2 Open Cup"
              />
            </label>
            <label className="md:col-span-2">
              <span className="mb-1 block text-xs text-[var(--text-secondary)]">Mô tả</span>
              <textarea
                rows={2}
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3.5 py-2.5 text-sm text-white focus:border-[var(--accent-primary)] focus:outline-none"
                placeholder="Thông tin giải đấu dành cho người chơi"
              />
            </label>
          </div>

          <fieldset disabled={submitting} className="rounded-2xl border border-purple-400/15 bg-purple-500/[0.025] p-4 disabled:opacity-60">
            <legend className="flex items-center gap-2 px-2 text-sm font-bold"><CalendarDays className="h-4 w-4 text-orange-400" />Lịch đăng ký và thi đấu</legend>
            <p className="mb-4 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><Clock3 className="h-3.5 w-3.5" />{deviceTimeZoneLabel()} · Định dạng 24 giờ</p>
            <div className="mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs font-semibold">Thiết lập nhanh</span><div className="flex flex-wrap gap-2">{[1,3,7].map(days => <button key={days} type="button" onClick={() => applyPreset(days)} className="rounded-lg border border-orange-400/20 bg-orange-400/5 px-3 py-2 text-xs font-semibold text-orange-300 hover:bg-orange-400/10">Đăng ký {days} ngày</button>)}</div></div>
              <p className="mt-2 text-[10px] leading-5 text-[var(--text-muted)]">Giữ mốc mở đăng ký đã chọn, bắt đầu giải sau khi đóng đăng ký 1 giờ.</p>
            </div>
            <div className="grid items-start gap-3 md:grid-cols-3">
              {([
                {key:'opens',label:'Mở đăng ký',value:registrationOpensAt,set:setRegistrationOpensAt,shortcuts:[{label:'Bây giờ',value:()=>localDateTimeValue(new Date())},{label:'Mai 08:00',value:()=>{const date=new Date();date.setDate(date.getDate()+1);date.setHours(8,0,0,0);return localDateTimeValue(date);}}]},
                {key:'closes',label:'Đóng đăng ký',value:registrationClosesAt,set:setRegistrationClosesAt,shortcuts:[{label:'Sau mở 1 ngày',value:()=>addScheduleTime(registrationOpensAt,1)},{label:'Sau mở 3 ngày',value:()=>addScheduleTime(registrationOpensAt,3)}]},
                {key:'starts',label:'Bắt đầu giải',value:tournamentStartsAt,set:setTournamentStartsAt,shortcuts:[{label:'Sau đóng 30 phút',value:()=>addScheduleTime(registrationClosesAt,0,30)},{label:'Sau đóng 1 giờ',value:()=>addScheduleTime(registrationClosesAt,0,60)}]},
              ] as const).map((field,index) => <div key={field.key} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3">
                <h3 className="mb-3 flex items-center gap-2 text-xs font-bold"><span className="flex h-5 w-5 items-center justify-center rounded-full border border-orange-400/25 bg-orange-400/10 text-[10px] text-orange-300">{index+1}</span>{field.label}</h3>
                <DateTimePicker label={field.label} value={field.value} onChange={field.set} error={errors[field.key]} shortcuts={[...field.shortcuts]} />
              </div>)}
            </div>
            {validSchedule && <p className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-500/5 px-3 py-2.5 text-[11px] leading-5 text-emerald-200/80"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>Đăng ký trong <strong>{scheduleDuration(registrationOpensAt,registrationClosesAt)}</strong> · Chuẩn bị <strong>{scheduleDuration(registrationClosesAt,tournamentStartsAt)}</strong> trước khi bắt đầu giải.</span></p>}
          </fieldset>

          <TournamentCustomization
            value={{ blockedCells, moveLimitRule, capturedPieceValues }}
            onChange={value => {
              setBlockedCells(value.blockedCells);
              setMoveLimitRule(value.moveLimitRule);
              setCapturedPieceValues(value.capturedPieceValues);
            }}
          />

          {formError && (
            <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {formError}
            </p>
          )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[#150e23] px-5 py-4 sm:px-6">
            <span className={`text-[10px] ${validSchedule ? 'text-[var(--text-muted)]' : 'text-red-300'}`}>{validSchedule ? 'Có thể chỉnh riêng từng mốc ngày, giờ.' : 'Cần sửa thứ tự thời gian trước khi tạo giải.'}</span>
            <div className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting || !validSchedule}
              className="rounded-xl bg-[var(--accent-primary)] px-5 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
            >
              {submitting ? 'Đang tạo giải…' : 'Tạo giải đấu'}
            </button>
            </div>
          </div>
        </form>


      </section>
    </div>
  );
};
