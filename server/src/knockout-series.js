import { randomInt } from 'node:crypto';
import { buildTournamentRules, calculateGroupStandings, createKnockoutOpeningRound, createNextKnockoutRound } from './tournament-format.js';

export function knockoutConfiguration(qualifiers, baseRules, body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Cấu hình knock-out không hợp lệ.'), { status: 400 });
  }
  const defaults = createKnockoutOpeningRound(qualifiers);
  const pairs = body.pairings ?? defaults.map(f => [f.player1Id, f.player2Id]);
  const ids = new Set(qualifiers.map(row => row.player_id));
  const flattened = Array.isArray(pairs) ? pairs.flat() : [];
  if (!Array.isArray(pairs) || pairs.length !== defaults.length ||
      pairs.some(pair => !Array.isArray(pair) || pair.length !== 2) ||
      flattened.length !== ids.size || new Set(flattened).size !== ids.size ||
      flattened.some(id => !ids.has(id))) {
    throw Object.assign(new Error('Mỗi đấu thủ nhất/nhì bảng phải xuất hiện đúng một lần trong các cặp knock-out.'), { status: 400 });
  }
  let rules;
  try {
    rules = buildTournamentRules(body.blockedCells ?? baseRules?.blockedCells ?? [],
      body.moveLimitRule ?? baseRules?.moveLimitRule ?? 'standard',
      body.capturedPieceValues ?? baseRules?.capturedPieceValues ?? { rock: 1, paper: 2, scissors: 3 });
  } catch (error) { throw Object.assign(error, { status: 400 }); }
  return { rules, fixtures: defaults.map((f, index) => ({ ...f, player1Id: pairs[index][0], player2Id: pairs[index][1] })) };
}

export function newKnockoutSeries(first, second) {
  return { series_best_of: 3, player1_score: 0, player2_score: 0, games_played: 0,
    series_games: [], next_first_player_id: randomInt(2) ? first : second };
}

export function recordKnockoutGame(fixture, match, winnerId, moveCount) {
  if (winnerId && ![fixture.player1_id, fixture.player2_id].includes(winnerId)) throw new Error('Invalid series winner');
  const firstWins = Number(fixture.player1_score || 0) + (winnerId === fixture.player1_id ? 1 : !winnerId ? 0.5 : 0);
  const secondWins = Number(fixture.player2_score || 0) + (winnerId === fixture.player2_id ? 1 : !winnerId ? 0.5 : 0);
  const games = Number(fixture.games_played || 0) + 1;
  const complete = (games >= 3 && firstWins !== secondWins) || (games === 2 && Math.max(firstWins, secondWins) === 2);
  return {
    player1_score: firstWins, player2_score: secondWins, games_played: Number(fixture.games_played || 0) + 1,
    status: complete ? 'completed' : 'pending', winner_id: complete ? (firstWins > secondWins ? fixture.player1_id : fixture.player2_id) : null,
    next_first_player_id: winnerId ? (winnerId === fixture.player1_id ? fixture.player2_id : fixture.player1_id) : match.player2_id,
    series_games: [...(fixture.series_games || []), { matchId: match.id, firstPlayerId: match.player1_id, winnerId, moveCount }],
  };
}

export function knockoutStartTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now()-60000) {
    throw Object.assign(new Error('Chọn thời gian bắt đầu knock-out từ thời điểm hiện tại trở đi.'), { status: 400 });
  }
  return date;
}

export async function prepareServerKnockout(client, tournamentId, body) {
  const tournament = (await client.query("SELECT * FROM tournaments WHERE id=$1 AND format='group_knockout' FOR UPDATE", [tournamentId])).rows[0];
  if (tournament?.status !== 'group_complete' && !(tournament?.status === 'knockout' && !tournament.knockout_started_at)) {
    throw Object.assign(new Error('Vòng bảng chưa hoàn tất hoặc knock-out đã khởi chạy.'), { status: 409 });
  }
  const existing = (await client.query("SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='knockout' ORDER BY match_number FOR UPDATE",[tournamentId])).rows;
  if (existing.some(f => f.status !== 'pending' || f.games_played || f.match_id || f.round_number !== 1 || f.leg > 1)) {
    throw Object.assign(new Error('Knock-out đã có trận thi đấu; không thể cấu hình lại.'), { status: 409 });
  }
  const entrants = (await client.query('SELECT player_id,group_number,registered_at FROM tournament_entries WHERE tournament_id=$1', [tournamentId])).rows;
  const played = (await client.query("SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group'", [tournamentId])).rows;
  if (!played.length || played.some(f => f.status !== 'completed')) throw Object.assign(new Error('Vòng bảng chưa hoàn tất.'), { status: 409 });
  const standings = calculateGroupStandings(entrants, played);
  const qualifiers = standings.filter((row, i) => standings.slice(0, i).filter(r => r.group_number === row.group_number).length < 2);
  const { rules, fixtures } = knockoutConfiguration(qualifiers, tournament.rules_json, body);
  const startsAt = knockoutStartTime(body.knockoutStartsAt);
  if (existing.length && existing.length !== fixtures.length) throw Object.assign(new Error('Nhánh cũ không khớp số đấu thủ vượt qua vòng bảng.'),{status:409});
  for (const [i,f] of fixtures.entries()) {
    if (!existing.length) await insertKnockoutSeries(client, tournamentId, f);
    else await client.query(`UPDATE tournament_fixtures SET player1_id=$2,player2_id=$3,series_best_of=3,
      player1_score=0,player2_score=0,games_played=0,series_games='[]'::jsonb,
      next_first_player_id=$4,player1_ready_at=NULL,player2_ready_at=NULL,leg=1 WHERE id=$1`,
    [existing[i].id,f.player1Id,f.player2Id,newKnockoutSeries(f.player1Id,f.player2Id).next_first_player_id]);
  }
  await client.query(`UPDATE tournaments SET status='knockout',execution_mode='server',knockout_rules_json=$2::jsonb,
    knockout_starts_at=$3,knockout_started_at=NULL,execution_paused_at=NULL WHERE id=$1`, [tournamentId, JSON.stringify(rules), startsAt]);
  return { fixtureCount: fixtures.length };
}

export async function startServerKnockout(client, tournamentId) {
  const tournament = (await client.query("SELECT *,knockout_starts_at<=now() AS can_start FROM tournaments WHERE id=$1 AND format='group_knockout' FOR UPDATE", [tournamentId])).rows[0];
  if (tournament?.status !== 'knockout' || tournament.knockout_started_at) {
    throw Object.assign(new Error('Cần phân nhánh knock-out trước; vòng đã chạy không thể khởi chạy lại.'), { status: 409 });
  }
  if (!tournament.can_start) {
    throw Object.assign(new Error('Chưa đến giờ bắt đầu vòng knock-out; người chơi vẫn có thể cập nhật Bot.'), { status: 409 });
  }
  const fixtures = (await client.query("SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='knockout' FOR UPDATE", [tournamentId])).rows;
  if (!fixtures.length || fixtures.some(f => f.status !== 'pending' || f.games_played || f.series_best_of !== 3)) throw Object.assign(new Error('Nhánh knock-out không sẵn sàng.'), { status: 409 });
  const ids = [...new Set(fixtures.flatMap(f => [f.player1_id,f.player2_id]))];
  const bots = (await client.query(`SELECT u.id,u.active_bot_version,b.code,b.code_sha256 FROM users u
    LEFT JOIN user_bot_versions b ON b.user_id=u.id AND b.version=u.active_bot_version
    WHERE u.id=ANY($1::uuid[]) ORDER BY u.id FOR UPDATE OF u`, [ids])).rows;
  if (bots.length !== ids.length || bots.some(b => !b.code?.trim())) throw Object.assign(new Error('Mỗi đấu thủ knock-out phải có code Bot đã lưu.'), { status: 409 });
  for (const bot of bots) await client.query(`UPDATE tournament_entries SET bot_version=$3,
    bot_code_snapshot=$4,bot_sha256_snapshot=$5 WHERE tournament_id=$1 AND player_id=$2`,
  [tournamentId,bot.id,bot.active_bot_version,bot.code,bot.code_sha256]);
  await client.query("UPDATE tournaments SET knockout_started_at=now(),execution_mode='server' WHERE id=$1", [tournamentId]);
  return { started: true };
}

async function insertKnockoutSeries(client, tournamentId, f) {
  const series = newKnockoutSeries(f.player1Id, f.player2Id);
  await client.query(`INSERT INTO tournament_fixtures(tournament_id,phase,round_number,match_number,leg,
    player1_id,player2_id,status,series_best_of,next_first_player_id)
    VALUES($1,'knockout',$2,$3,1,$4,$5,'pending',3,$6)`,
  [tournamentId, f.roundNumber, f.matchNumber, f.player1Id, f.player2Id, series.next_first_player_id]);
}

export async function completeServerKnockoutGame(client, fixture, match, winnerId, moves) {
  if (fixture.match_id !== match.id) return;
  const result = recordKnockoutGame(fixture, match, winnerId, moves);
  await client.query(`UPDATE tournament_fixtures SET player1_score=$2,player2_score=$3,games_played=$4,
    status=$5,winner_id=$6,next_first_player_id=$7,series_games=$8::jsonb,move_count=$9,
    match_id=CASE WHEN $5='completed' THEN match_id ELSE NULL END,leg=$4+1,
    player1_ready_at=NULL,player2_ready_at=NULL WHERE id=$1`,
  [fixture.id,result.player1_score,result.player2_score,result.games_played,result.status,result.winner_id,
    result.next_first_player_id,JSON.stringify(result.series_games),moves]);
  if (result.status !== 'completed') return;
  const round = (await client.query(`SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND phase='knockout'
    AND round_number=$2 ORDER BY match_number FOR UPDATE`, [match.tournament_id,fixture.round_number])).rows;
  if (round.some(f => f.status !== 'completed')) return;
  if (round.length === 1) {
    await client.query("UPDATE tournaments SET status='completed',ends_at=now(),execution_paused_at=NULL WHERE id=$1", [match.tournament_id]);
  } else {
    for (const f of createNextKnockoutRound(round.map(f => f.winner_id), Number(fixture.round_number)+1)) {
      await insertKnockoutSeries(client,match.tournament_id,f);
    }
  }
}
