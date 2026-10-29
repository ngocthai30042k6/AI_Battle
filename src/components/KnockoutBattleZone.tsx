import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Loader2, Play, RefreshCw, Swords, X } from 'lucide-react';
import { backendClient, PLAYER_AVATARS } from '../core/backendClient';
import { knockoutRoundLabel } from '../core/knockoutPresentation';
import { KnockoutFinal } from './KnockoutFinal';
import { ReplayModal } from './ReplayModal';

export function KnockoutBattleZone({ tournamentId, tournamentName, fixtures, avatars, userId, themeMode, onClose }: {
  tournamentId: string; tournamentName: string; fixtures: any[];
  avatars: Map<string, {avatarId?: string; avatarUrl?: string | null}>;
  userId?: string; themeMode: 'halloween' | 'standard'; onClose: () => void;
}) {
  const opening = fixtures.filter(f => Number(f.round_number) === 1).length;
  const roundCount = opening ? Math.ceil(Math.log2(opening)) + 1 : 0;
  const [round, setRound] = useState(1);
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [replayError, setReplayError] = useState('');
  const [replayLoading, setReplayLoading] = useState<string | null>(null);
  const [replay, setReplay] = useState<{data: any; p1: string; p2: string} | null>(null);
  const requestId = useRef(0);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false, busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const items = await backendClient.getKnockoutMatches(tournamentId);
        if (!cancelled) { setMatches(items); setError(''); }
      } catch (err: any) { if (!cancelled) setError(err.message || 'Không tải được kết quả.'); }
      finally { busy = false; if (!cancelled) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [tournamentId, refresh]);
  useEffect(() => () => { requestId.current++; }, []);
  const watch = async (game: any) => {
    const id = ++requestId.current;
    setReplayLoading(game.id); setReplayError('');
    try {
      const data = await backendClient.getMatchReplay(game.id);
      if (id === requestId.current) setReplay({data, p1: game.player1, p2: game.player2});
    } catch (err: any) { if (id === requestId.current) setReplayError(err.message || 'Không tải được replay.'); }
    finally { if (id === requestId.current) setReplayLoading(null); }
  };
  const player = (id?: string, name = '?', winner = false) => {
    const avatar = avatars.get(id || '');
    return <div className="min-w-0 text-center">
      <div className={`relative mx-auto mb-2 flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border-2 bg-[var(--bg-panel)] text-3xl shadow-lg sm:h-20 sm:w-20 ${winner ? 'border-yellow-400 shadow-yellow-500/15' : id === userId ? 'border-orange-400' : 'border-purple-400/40'}`}>
        {PLAYER_AVATARS.find(a => a.id === avatar?.avatarId)?.emoji || '🤖'}
        {avatar?.avatarUrl && <img src={avatar.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={event => {event.currentTarget.style.display='none';}} />}
      </div>
      <p className={`break-words text-sm font-bold [overflow-wrap:anywhere] ${id && id === userId ? 'rounded bg-orange-500/15 px-1 text-orange-300' : winner ? 'text-yellow-300' : 'text-[var(--text-primary)]'}`}>{name}{id && id === userId ? ' (Bạn)' : ''}</p>
    </div>;
  };
  return createPortal(<>
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-2 backdrop-blur-sm sm:p-5">
      <section role="dialog" aria-modal="true" aria-labelledby="battle-zone-title" className="flex h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-purple-400/30 bg-[var(--bg-elevated)] shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] p-4 sm:px-6">
          <div><h2 id="battle-zone-title" className="flex items-center gap-2 text-xl font-black"><Swords className="text-orange-400" />Battle Zone</h2><p className="mt-1 text-xs text-[var(--text-muted)]">{tournamentName} · Kết quả và replay Knock-Out dành cho mọi người</p></div>
          <div className="flex gap-2"><button type="button" onClick={() => setRefresh(value => value + 1)} aria-label="Làm mới Battle Zone" className="rounded-lg p-2 hover:bg-[var(--bg-hover)]"><RefreshCw className="h-4 w-4" /></button><button autoFocus type="button" onClick={onClose} aria-label="Đóng Battle Zone" className="rounded-lg p-2 hover:bg-[var(--bg-hover)]"><X /></button></div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav aria-label="Chọn vòng Knock-Out" className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 md:w-44 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
            {Array.from({length: roundCount}, (_, index) => index + 1).map(number => <button type="button" key={number} onClick={() => setRound(number)} aria-pressed={round === number} className={`shrink-0 rounded-xl border p-3 text-left text-sm font-bold ${round === number ? 'border-orange-400/60 bg-orange-500/15 text-orange-300' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
              {knockoutRoundLabel(opening, number)}<span className="mt-1 block text-[10px] font-normal">{fixtures.filter(f => Number(f.round_number) === number && f.status === 'completed').length}/{opening / 2 ** (number - 1)} cặp hoàn tất</span>
            </button>)}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.12),transparent_65%)] p-4 sm:p-6">
            {loading && <p role="status" className="mb-4 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Đang tải kết quả…</p>}
            {error && <p role="alert" className="mb-4 text-sm text-red-300">{error}</p>}
            {replayError && <p role="alert" className="mb-4 text-sm text-red-300">{replayError}</p>}
            {!fixtures.some(f => Number(f.round_number) === round) && <p className="py-12 text-center text-sm text-[var(--text-muted)]">Chưa xác định cặp đấu của vòng này.</p>}
            <div className={`grid items-start gap-5 ${round === roundCount ? 'mx-auto max-w-2xl' : 'xl:grid-cols-2'}`}>
              {fixtures.filter(f => Number(f.round_number) === round).sort((a,b) => Number(a.match_number)-Number(b.match_number)).map(fixture => {
                const games = matches.filter(m => m.tournament_fixture_id === fixture.id).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
                return <article key={fixture.id} className={`min-w-0 rounded-2xl border bg-[var(--bg-canvas)] p-4 sm:p-5 ${[fixture.player1_id,fixture.player2_id].includes(userId) ? 'border-orange-400/70 ring-1 ring-orange-400/20' : 'border-purple-400/20'}`}>
                  <div className="mb-5 flex items-center justify-between gap-2 text-xs"><strong className="text-orange-400">Cặp {fixture.match_number} · {fixture.series_best_of === 3 ? 'BO3' : 'BO1'}</strong><span className="text-[var(--text-muted)]">{fixture.status === 'completed' ? 'Đã kết thúc' : fixture.status === 'active' ? 'Đang thi đấu' : 'Chờ thi đấu'}</span></div>
                  {round === roundCount ? <KnockoutFinal final={fixture} userId={userId} /> : <>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
                      {player(fixture.player1_id,fixture.player1,fixture.winner_id === fixture.player1_id)}
                      <div className="text-center"><Swords className="mx-auto mb-2 h-5 w-5 text-purple-400" /><strong className="whitespace-nowrap font-mono text-xl text-orange-400">{fixture.series_best_of === 3 ? `${Number(fixture.player1_score || 0)}–${Number(fixture.player2_score || 0)}` : fixture.winner_id ? fixture.winner_id === fixture.player1_id ? '1–0' : '0–1' : 'vs'}</strong></div>
                      {player(fixture.player2_id,fixture.player2,fixture.winner_id === fixture.player2_id)}
                    </div>
                    {fixture.winner_id && <div className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-yellow-400/20 bg-yellow-500/5 p-3"><ArrowRight className="h-4 w-4 shrink-0 text-yellow-400" /><span className="text-sm font-bold text-yellow-300">Đi tiếp: {fixture.winner}{fixture.winner_id === userId ? ' (Bạn)' : ''}</span></div>}
                  </>}
                  <div className="mt-5 space-y-2 border-t border-[var(--border-subtle)] pt-4">
                    {!games.length && <p className="text-xs text-[var(--text-muted)]">Chưa có ván đấu được ghi nhận.</p>}
                    {games.map((game,index) => <div key={game.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--bg-panel)] p-2.5 text-xs">
                      <div className="min-w-0"><strong>{index >= 3 ? `Ván phụ ${index-2}` : `Ván ${index+1}`}</strong><p className={`mt-1 break-words ${game.winner_id && game.winner_id === userId ? 'font-bold text-orange-300' : 'text-[var(--text-secondary)]'}`}>{game.status !== 'completed' ? game.status === 'abandoned' ? 'Ván đấu bị gián đoạn' : 'Đang thi đấu' : !game.winner_id ? 'Hòa' : `Thắng: ${game.winner_id === game.player1_id ? game.player1 : game.player2}${game.winner_id === userId ? ' (Bạn)' : ''}`} · {game.move_count ?? 0} nước</p><p className={`mt-1 text-[10px] ${game.player1_id === userId ? 'text-orange-300' : 'text-[var(--text-muted)]'}`}>Đi trước: {game.player1}{game.player1_id === userId ? ' (Bạn)' : ''}</p></div>
                      <button type="button" disabled={!game.replay_available || game.status !== 'completed' || replayLoading !== null} onClick={() => void watch(game)} aria-label={`Xem replay ${fixture.player1} gặp ${fixture.player2}, ván ${index+1}`} className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/30 px-3 py-2 font-bold text-orange-400 hover:bg-orange-500/10 disabled:opacity-40">{replayLoading === game.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Replay</button>
                    </div>)}
                  </div>
                </article>;
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
    {replay && <div className="fixed inset-0 z-[100]"><ReplayModal open replayData={replay.data} player1Name={replay.p1} player2Name={replay.p2} themeMode={themeMode} onClose={() => setReplay(null)} /></div>}
  </>, document.body);
}
