export function minimumTournamentElo(value) {
  const elo = Number(value ?? 0);
  if (!Number.isInteger(elo) || elo < 0 || elo > 10000) {
    throw Object.assign(new Error('Elo tối thiểu phải là số nguyên từ 0 đến 10000.'), { status: 400 });
  }
  return elo;
}
export function requireTournamentElo(tournament, player) {
  const minimum = Number(tournament.min_elo || 0);
  if (Number(player.elo) < minimum) {
    throw Object.assign(new Error(`Cần ít nhất ${minimum} Elo để đăng ký giải này. Elo hiện tại: ${player.elo}.`), { status: 403 });
  }
}
