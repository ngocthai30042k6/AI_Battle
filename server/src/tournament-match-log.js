export const MATCH_LOG_PAGE_SIZE = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function matchLogFilters(params) {
  const phase = params.get('phase') || 'group', scope = params.get('scope') || 'mine';
  if (!['group', 'knockout'].includes(phase) || !['mine', 'all'].includes(scope)) throw Object.assign(new Error('Bộ lọc nhật ký không hợp lệ.'), {status:400});
  let cursor = null;
  if (params.get('cursor')) {
    try {
      if (params.get('cursor').length > 512) throw new Error();
      cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString());
      if (!uuid.test(cursor.id) || typeof cursor.at !== 'string' || !Number.isFinite(new Date(cursor.at).getTime())) throw new Error();
    } catch { throw Object.assign(new Error('Mốc phân trang không hợp lệ.'), {status:400}); }
  }
  return { phase, scope, cursor, search: (params.get('q') || '').trim().slice(0,100) };
}

export function matchLogPage(rows, total) {
  const more = rows.length > MATCH_LOG_PAGE_SIZE, page = rows.slice(0,MATCH_LOG_PAGE_SIZE);
  const last = page[page.length - 1];
  const nextCursor = more ? Buffer.from(JSON.stringify({at:last.cursor_at || last.created_at,id:last.id})).toString('base64url') : null;
  return {matches:page.map(({cursor_at,...row})=>row),total:Number(total),nextCursor};
}

export async function getTournamentMatchLog(pool, tournamentId, userId, filters, externalReplays) {
  if (filters.scope === 'all') {
    const admin = (await pool.query('SELECT is_admin FROM users WHERE id=$1',[userId])).rows[0];
    if (!admin?.is_admin) throw Object.assign(new Error('Chỉ quản trị viên được xem toàn bộ nhật ký giải.'),{status:403});
  }
  const joins = `FROM matches m JOIN tournaments t ON t.id=m.tournament_id
    JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id
    LEFT JOIN tournament_fixtures f ON f.id=m.tournament_fixture_id AND f.tournament_id=m.tournament_id
    LEFT JOIN users winner ON winner.id=m.winner_id`;
  const where = `WHERE m.tournament_id=$1 AND m.status='completed' AND t.format='group_knockout' AND t.status<>'cancelled'
    AND (${filters.scope === 'all' ? '$2::uuid IS NOT NULL' : 'm.player1_id=$2 OR m.player2_id=$2'})
    AND COALESCE(f.phase,m.tournament_phase)=$3
    AND ($4='' OR concat_ws(' ',u1.display_name,u2.display_name,winner.display_name,m.id::text) ILIKE '%' || $4 || '%')`;
  const args = [tournamentId,userId,filters.phase,filters.search];
  const [rows,count] = await Promise.all([
    pool.query(`SELECT m.id,m.id AS match_id,m.status,m.tournament_phase,m.player1_id,m.player2_id,
      m.winner_id,winner.display_name AS winner,m.final_step_count AS move_count,
      u1.display_name AS player1,u2.display_name AS player2,COALESCE(f.phase,m.tournament_phase) AS phase,
      f.group_number,f.round_number,f.leg,m.created_at,m.completed_at,m.created_at::text AS cursor_at,
      (m.replay_json IS NOT NULL OR (m.replay_key IS NOT NULL AND $7::boolean)) AS replay_available
      ${joins} ${where} AND ($5::timestamptz IS NULL OR (m.created_at,m.id)<($5::timestamptz,$6::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT ${MATCH_LOG_PAGE_SIZE+1}`,
      [...args,filters.cursor?.at || null,filters.cursor?.id || null,externalReplays]),
    pool.query(`SELECT count(*)::int AS total ${joins} ${where}`,args),
  ]);
  return matchLogPage(rows.rows,count.rows[0].total);
}
