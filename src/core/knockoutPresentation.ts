export function knockoutRoundLabel(openingMatches: number, round: number) {
  const players = Math.max(2, (openingMatches * 2) / (2 ** (round - 1)));
  return players === 2 ? 'Chung kết' : players === 4 ? 'Bán kết' : players === 8 ? 'Tứ kết' : `Vòng 1/${players / 2}`;
}

export function orderedFinalists(final: any) {
  const players = [1, 2].map(seat => ({
    id: final?.[`player${seat}_id`], name: final?.[`player${seat}`] || '?',
    score: Number(final?.[`player${seat}_score`] || 0),
  }));
  const decided = final?.status === 'completed' && players.some(player => player.id && player.id === final.winner_id);
  if (decided && players[1].id === final.winner_id) players.reverse();
  return { players, decided: Boolean(decided) };
}

export function knockoutNoticeKey(userId: string, tournamentId: string) {
  return `ottv2-knockout-notice:${userId}:${tournamentId}`;
}

export function localCalendarDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
