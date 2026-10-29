import { MIN_TOURNAMENT_GAP_MS, PREPARATION_GAP_ERROR, REGISTRATION_GAP_ERROR } from '../../shared/tournamentScheduleRules.mjs';

export function localDateTimeValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function parseLocalDateTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && localDateTimeValue(date) === value ? date : null;
}

export function addScheduleTime(value: string, days = 0, minutes = 0) {
  const date = parseLocalDateTime(value);
  if (!date) return '';
  date.setTime(date.getTime() + days * MIN_TOURNAMENT_GAP_MS + minutes * 60000);
  return localDateTimeValue(date);
}

export function scheduleErrors(opens: string, closes: string, starts: string) {
  const opening = parseLocalDateTime(opens), closing = parseLocalDateTime(closes), starting = parseLocalDateTime(starts);
  return {
    opens: opening ? '' : 'Chọn đầy đủ ngày và giờ mở đăng ký.',
    closes: !closing ? 'Chọn đầy đủ ngày và giờ đóng đăng ký.' : opening && closing.getTime() - opening.getTime() < MIN_TOURNAMENT_GAP_MS ? REGISTRATION_GAP_ERROR : '',
    starts: !starting ? 'Chọn đầy đủ ngày và giờ bắt đầu giải.' : closing && starting.getTime() - closing.getTime() < MIN_TOURNAMENT_GAP_MS ? PREPARATION_GAP_ERROR : '',
  };
}

export function scheduleDuration(from: string, to: string) {
  const first = parseLocalDateTime(from), second = parseLocalDateTime(to);
  if (!first || !second || second <= first) return '';
  const total = Math.round((second.getTime() - first.getTime()) / 60000);
  const days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), minutes = total % 60;
  return [days && `${days} ngày`, hours && `${hours} giờ`, minutes && `${minutes} phút`].filter(Boolean).join(' ');
}

export function deviceTimeZoneLabel() {
  const offset = -new Date().getTimezoneOffset();
  return `Giờ trên thiết bị · GMT${offset >= 0 ? '+' : '−'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
}
