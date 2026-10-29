import { calculateGroupStandings } from './tournament-format.js';

export function qualifiedForKnockout(playerId, tournament, entries, fixtures) {
  if (!['group_complete', 'knockout'].includes(tournament.status)) return false;
  const opening = fixtures.filter(f => f.phase === 'knockout' && Number(f.round_number) === 1);
  if (opening.length) return opening.some(f => [f.player1_id, f.player2_id].includes(playerId));
  if (tournament.status !== 'group_complete') return false;
  const standings = calculateGroupStandings(entries, fixtures);
  const own = standings.find(row => row.player_id === playerId);
  return Boolean(own && standings.filter(row => row.group_number === own.group_number).slice(0, 2).some(row => row.player_id === playerId));
}

export async function getKnockoutNotices(pool, playerId) {
  const tournaments = (await pool.query(`SELECT t.id,t.name,t.status,t.knockout_starts_at,e.group_number
    FROM tournaments t JOIN tournament_entries e ON e.tournament_id=t.id AND e.player_id=$1
    WHERE t.format='group_knockout' AND t.status IN ('group_complete','knockout')
    ORDER BY t.created_at DESC`, [playerId])).rows;
  const notices = [];
  for (const tournament of tournaments) {
    let qualified;
    if (tournament.status === 'knockout') {
      qualified = (await pool.query(`SELECT 1 FROM tournament_fixtures WHERE tournament_id=$1
        AND phase='knockout' AND round_number=1 AND (player1_id=$2 OR player2_id=$2) LIMIT 1`, [tournament.id, playerId])).rows.length > 0;
    } else {
      // Only load the player's own group, even in a 70,000-game tournament.
      const [entries, fixtures] = await Promise.all([
        pool.query('SELECT player_id,group_number,registered_at FROM tournament_entries WHERE tournament_id=$1 AND group_number=$2', [tournament.id,tournament.group_number]),
        pool.query("SELECT player1_id,player2_id,winner_id,status,phase,move_count FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group' AND group_number=$2", [tournament.id,tournament.group_number]),
      ]);
      qualified = qualifiedForKnockout(playerId, tournament, entries.rows, fixtures.rows);
    }
    if (qualified) { const {group_number, ...notice} = tournament; notices.push(notice); }
  }
  return notices;
}

export async function getReplayForViewer(pool, matchId, viewerId) {
  const match = (await pool.query(`SELECT m.replay_json,m.replay_key,m.player1_id,m.player2_id,
    (f.phase='knockout' AND t.format='group_knockout' AND t.status<>'cancelled') AS public_knockout
    FROM matches m LEFT JOIN tournament_fixtures f ON f.id=m.tournament_fixture_id AND f.tournament_id=m.tournament_id
    LEFT JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=$1 AND m.status='completed'`, [matchId])).rows[0];
  return match && (match.public_knockout || [match.player1_id,match.player2_id].includes(viewerId)) ? match : null;
}

export async function getPublicKnockoutMatches(pool, tournamentId, externalReplays) {
  return (await pool.query(`SELECT m.id,m.tournament_fixture_id,m.status,m.player1_id,m.player2_id,
    m.winner_id,m.final_step_count AS move_count,m.completed_at,m.created_at,
    f.round_number,f.match_number,f.leg,u1.display_name AS player1,u2.display_name AS player2,
    (m.replay_json IS NOT NULL OR (m.replay_key IS NOT NULL AND $2::boolean)) AS replay_available
    FROM matches m JOIN tournament_fixtures f ON f.id=m.tournament_fixture_id AND f.tournament_id=m.tournament_id
    JOIN tournaments t ON t.id=m.tournament_id
    JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id
    WHERE m.tournament_id=$1 AND f.phase='knockout' AND t.format='group_knockout' AND t.status<>'cancelled'
    ORDER BY f.round_number,f.match_number,m.created_at,m.id`, [tournamentId, externalReplays])).rows;
}
