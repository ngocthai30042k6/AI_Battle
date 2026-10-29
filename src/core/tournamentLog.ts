export function hasKnockoutPlace(detail: any, userId?: string): boolean {
  if (!userId) return false;
  const opening = (detail?.fixtures || []).filter((f: any) => f.phase === 'knockout' && Number(f.round_number) === 1);
  if (opening.length) return opening.some((f: any) => [f.player1_id, f.player2_id].includes(userId));
  if (!['group_complete', 'knockout', 'completed'].includes(detail?.tournament?.status)) return false;
  return (detail?.groups || []).some((g: any) => (g.standings || []).slice(0, 2).some((p: any) => p.player_id === userId));
}

export function tournamentGameOutcome(match: any, userId: string) {
  const knockout = (match.phase || match.tournament_phase) === 'knockout';
  if (!match.winner_id) return `HÒA · +${knockout ? '0.5' : '1'} ĐIỂM`;
  return match.winner_id === userId ? `THẮNG · +${knockout ? '1' : '3'} ĐIỂM` : 'THUA · +0 ĐIỂM';
}
