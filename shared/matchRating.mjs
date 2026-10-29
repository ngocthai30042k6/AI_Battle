export function isTournamentMatch(match) {
  return Boolean(match.tournament_id || ['group', 'knockout'].includes(match.tournament_phase));
}

export function isEloRatedMatch(match) {
  return match.match_type === 'bot' && !match.is_sparring &&
    match.tournament_phase !== 'practice' && !isTournamentMatch(match);
}

// Same predicate for the match-history query (its matches table alias is m).
export const ELO_RATED_MATCH_SQL = `m.match_type='bot' AND NOT m.is_sparring
  AND m.tournament_id IS NULL AND COALESCE(m.tournament_phase,'ranked') NOT IN ('practice','group','knockout')`;
