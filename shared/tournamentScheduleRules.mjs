export const MIN_TOURNAMENT_GAP_MS = 86400000;
export const REGISTRATION_GAP_ERROR = 'Đóng đăng ký phải sau mở đăng ký ít nhất 1 ngày (24 giờ).';
export const PREPARATION_GAP_ERROR = 'Bắt đầu giải phải sau đóng đăng ký ít nhất 1 ngày (24 giờ).';

export function requireTournamentScheduleGaps(opens, closes, starts) {
  if ([opens,closes,starts].some(date => !(date instanceof Date) || !Number.isFinite(date.getTime()))) throw Object.assign(new Error('Ngày giờ giải đấu không hợp lệ.'),{status:400});
  const error = closes.getTime() - opens.getTime() < MIN_TOURNAMENT_GAP_MS ? REGISTRATION_GAP_ERROR
    : starts.getTime() - closes.getTime() < MIN_TOURNAMENT_GAP_MS ? PREPARATION_GAP_ERROR : null;
  if (error) throw Object.assign(new Error(error), { status: 400 });
}
