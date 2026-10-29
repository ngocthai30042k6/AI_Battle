import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, X } from 'lucide-react';
import { localDateTimeValue, parseLocalDateTime } from '../core/tournamentSchedule';

export type DateTimeShortcut = { label: string; value: () => string };

function sameDay(first: Date, second: Date) {
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate();
}

function CalendarDialog({ value, label, onChoose, onClose }: {
  value: string; label: string; onChoose: (date: Date) => void; onClose: () => void;
}) {
  const selected = parseLocalDateTime(value), today = new Date();
  const [month, setMonth] = useState(() => {const date = selected || today; return new Date(date.getFullYear(), date.getMonth(), 1, 12);});
  const dialog = useRef<HTMLElement>(null);
  const headingId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('[aria-pressed="true"], [data-today="true"], [data-calendar-day]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onClose();}
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select') || []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {window.removeEventListener('keydown', keydown, true); previous?.focus();};
  }, [onClose]);
  const start = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  start.setDate(1 - (start.getDay() + 6) % 7);
  const years = Array.from({length: Math.max(today.getFullYear() + 10, month.getFullYear()) - Math.min(today.getFullYear() - 1, month.getFullYear()) + 1}, (_, index) => Math.min(today.getFullYear() - 1, month.getFullYear()) + index);
  const shiftMonth = (delta: number) => setMonth(current => new Date(current.getFullYear(), current.getMonth() + delta, 1, 12));
  return createPortal(<div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" onClick={event => {if (event.target === event.currentTarget) onClose();}}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} className="w-full max-w-sm rounded-2xl border border-orange-400/30 bg-[#1a1229] p-5 shadow-2xl">
      <div className="mb-5 flex items-center justify-between gap-3"><h3 id={headingId} className="text-base font-bold">Chọn ngày · {label}</h3><button type="button" onClick={onClose} aria-label="Đóng lịch" className="rounded-lg p-2 text-[var(--text-secondary)] hover:bg-white/5"><X className="h-4 w-4" /></button></div>
      <div className="mb-4 flex items-center gap-2">
        <button type="button" aria-label="Tháng trước" onClick={() => shiftMonth(-1)} className="rounded-lg border border-[var(--border-subtle)] p-2.5"><ChevronLeft className="h-4 w-4" /></button>
        <select aria-label="Tháng" value={month.getMonth()} onChange={event => setMonth(current => new Date(current.getFullYear(), Number(event.target.value), 1, 12))} className="min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[#241a35] px-2 py-2.5 text-sm">{Array.from({length:12}, (_, index) => <option key={index} value={index}>Tháng {index + 1}</option>)}</select>
        <select aria-label="Năm" value={month.getFullYear()} onChange={event => setMonth(current => new Date(Number(event.target.value), current.getMonth(), 1, 12))} className="rounded-lg border border-[var(--border-subtle)] bg-[#241a35] px-2 py-2.5 text-sm">{years.map(year => <option key={year} value={year}>{year}</option>)}</select>
        <button type="button" aria-label="Tháng sau" onClick={() => shiftMonth(1)} className="rounded-lg border border-[var(--border-subtle)] p-2.5"><ChevronRight className="h-4 w-4" /></button>
      </div>
      <div className="mb-2 grid grid-cols-7 text-center text-[10px] font-semibold text-[var(--text-muted)]">{['T2','T3','T4','T5','T6','T7','CN'].map(day => <span key={day}>{day}</span>)}</div>
      <div role="group" aria-label="Các ngày trong tháng" className="grid grid-cols-7 gap-1">
        {Array.from({length:42}, (_, index) => {
          const date = new Date(start); date.setDate(start.getDate() + index);
          const active = Boolean(selected && sameDay(selected, date)), current = sameDay(today, date);
          return <button key={date.toISOString()} type="button" data-calendar-day data-today={current} aria-pressed={active}
            aria-label={date.toLocaleDateString('vi-VN', {weekday:'long',day:'numeric',month:'long',year:'numeric'})}
            onClick={() => onChoose(date)} className={`aspect-square rounded-lg text-sm font-semibold ${active ? 'bg-orange-500 text-white shadow-lg shadow-orange-950/30' : current ? 'border border-orange-400/60 text-orange-300' : date.getMonth() !== month.getMonth() ? 'text-[var(--text-muted)]/50 hover:bg-white/5' : 'text-[var(--text-primary)] hover:bg-purple-400/15'}`}>{date.getDate()}</button>;
        })}
      </div>
      <div className="mt-4 flex gap-2 border-t border-[var(--border-subtle)] pt-4">{[0,1].map(offset => <button key={offset} type="button" onClick={() => {const date = new Date(); date.setDate(date.getDate() + offset); onChoose(date);}} className="flex-1 rounded-xl border border-[var(--border-subtle)] bg-white/[0.025] py-2.5 text-xs font-bold text-orange-300">{offset ? 'Ngày mai' : 'Hôm nay'}</button>)}</div>
    </section>
  </div>, document.body);
}

export function DateTimePicker({ label, value, onChange, error, shortcuts = [], disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; error?: string;
  shortcuts?: DateTimeShortcut[]; disabled?: boolean;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const errorId = useId();
  const parsed = parseLocalDateTime(value);
  const hour = parsed ? String(parsed.getHours()).padStart(2, '0') : '', minute = parsed ? String(parsed.getMinutes()).padStart(2, '0') : '';
  const changeTime = (part: 'hour' | 'minute', next: string) => {
    const date = parsed || new Date();
    if (part === 'hour') date.setHours(Number(next)); else date.setMinutes(Number(next));
    onChange(localDateTimeValue(date));
  };
  const control = `rounded-xl border bg-[var(--bg-canvas)] text-sm text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-orange-400/40 ${error ? 'border-red-400/60' : 'border-[var(--border-subtle)] focus:border-orange-400/50'}`;
  return <div className="min-w-0">
    <span className="sr-only">{label}</span>
    <button type="button" disabled={disabled} aria-label={`Chọn ngày ${label}`} aria-haspopup="dialog" aria-expanded={calendarOpen} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onClick={() => setCalendarOpen(true)} className={`${control} flex w-full items-center gap-2 px-3 py-3 text-left disabled:opacity-50`}><CalendarDays className="h-4 w-4 shrink-0 text-orange-400" /><span className="flex-1 font-semibold">{parsed ? parsed.toLocaleDateString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric'}) : 'Chọn ngày'}</span><ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" /></button>
    <div className="mt-2 flex items-center gap-2">
      <Clock3 className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <select disabled={disabled} aria-label={`Giờ ${label}`} value={hour} onChange={event => changeTime('hour', event.target.value)} className={`${control} min-w-0 flex-1 px-3 py-2.5 font-mono`}><option value="" disabled>Giờ</option>{Array.from({length:24},(_,index)=><option key={index} value={String(index).padStart(2,'0')}>{String(index).padStart(2,'0')} giờ</option>)}</select>
      <span className="text-[var(--text-muted)]">:</span>
      <select disabled={disabled} aria-label={`Phút ${label}`} value={minute} onChange={event => changeTime('minute', event.target.value)} className={`${control} min-w-0 flex-1 px-3 py-2.5 font-mono`}><option value="" disabled>Phút</option>{Array.from({length:60},(_,index)=><option key={index} value={String(index).padStart(2,'0')}>{String(index).padStart(2,'0')} phút</option>)}</select>
    </div>
    {shortcuts.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{shortcuts.map(shortcut=><button key={shortcut.label} type="button" disabled={disabled} onClick={()=>onChange(shortcut.value())} className="rounded-lg border border-purple-300/10 bg-purple-400/5 px-2 py-1.5 text-[10px] font-semibold text-purple-200/80 hover:border-orange-400/30 hover:text-orange-300 disabled:opacity-50">{shortcut.label}</button>)}</div>}
    {error && <p id={errorId} role="alert" className="mt-2 text-xs leading-5 text-red-300">{error}</p>}
    {calendarOpen && !disabled && <CalendarDialog label={label} value={value} onChoose={date => {date.setHours(parsed?.getHours() ?? 8, parsed?.getMinutes() ?? 0, 0, 0); onChange(localDateTimeValue(date)); setCalendarOpen(false);}} onClose={() => setCalendarOpen(false)} />}
  </div>;
}
