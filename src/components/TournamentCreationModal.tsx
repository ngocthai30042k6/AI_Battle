import React, { useState } from 'react';
import { X } from 'lucide-react';
import { TournamentCustomization } from './TournamentCustomization';

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

function localDateTimeValue(date: Date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const opens = new Date(registrationOpensAt);
    const closes = new Date(registrationClosesAt);
    const starts = new Date(tournamentStartsAt);
    if (opens >= closes || closes >= starts) {
      setFormError('Thời gian cần theo thứ tự: mở đăng ký, đóng đăng ký, bắt đầu giải.');
      return;
    }
    setFormError('');
    await onSubmit({
      minElo,
      name,
      description,
      registrationOpensAt: opens.toISOString(),
      registrationClosesAt: closes.toISOString(),
      tournamentStartsAt: starts.toISOString(),
      blockedCells,
      moveLimitRule,
      capturedPieceValues,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm sm:items-center"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-tournament-heading"
        className="my-auto w-full max-w-4xl rounded-2xl border border-[var(--border-accent)] bg-[#150e23] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] p-5 sm:p-6">
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

        <form onSubmit={submit} className="space-y-5 p-5 sm:p-6">
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
            {[
              ['registration-opens', 'Thời gian mở đăng ký', registrationOpensAt, setRegistrationOpensAt],
              ['registration-closes', 'Thời gian đóng đăng ký', registrationClosesAt, setRegistrationClosesAt],
              ['tournament-starts', 'Thời gian bắt đầu giải', tournamentStartsAt, setTournamentStartsAt],
            ].map(([id, label, value, setter]) => (
              <label key={id as string}>
                <span className="mb-1 block text-xs text-[var(--text-secondary)]">{label as string}</span>
                <input
                  type="datetime-local"
                  required
                  value={value as string}
                  onChange={(event) => (setter as (value: string) => void)(event.target.value)}
                  className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-canvas)] px-3 py-2.5 text-sm text-white [color-scheme:dark]"
                />
              </label>
            ))}
          </div>

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

          <div className="flex justify-end gap-2 border-t border-[var(--border-subtle)] pt-4">
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
              disabled={submitting}
              className="rounded-xl bg-[var(--accent-primary)] px-5 py-2 text-xs font-semibold text-white hover:bg-[var(--accent-primary-hover)] disabled:opacity-50"
            >
              {submitting ? 'Đang tạo giải…' : 'Tạo giải đấu'}
            </button>
          </div>
        </form>


      </section>
    </div>
  );
};
