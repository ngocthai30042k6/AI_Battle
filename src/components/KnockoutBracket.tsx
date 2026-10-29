import React, { useLayoutEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { knockoutRoundLabel } from '../core/knockoutPresentation';
import { KnockoutFinal } from './KnockoutFinal';
import { KnockoutChampion } from './KnockoutChampion';
import { TournamentAvatar } from './TournamentAvatar';

type Connection = { key: string; path: string; own: boolean; complete: boolean; x: number; y: number };

export function KnockoutBracket({ fixtures, openingMatches, avatars, userId }: {
  fixtures: any[]; openingMatches: number;
  avatars: Map<string, { avatarId?: string; avatarUrl?: string | null }>; userId?: string;
}) {
  const rounds = Math.ceil(Math.log2(openingMatches)) + 1;
  const gridRows = Math.max(2, openingMatches * 2 - 2);
  const gridRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ width: number; height: number; paths: Connection[] }>({width: 0, height: 0, paths: []});
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let frame = 0;
    const measure = () => {
      const bounds = grid.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const cards = Array.from(grid.querySelectorAll<HTMLElement>('[data-bracket-round]'));
      const paths: Connection[] = [];
      for (const card of cards) {
        const round = Number(card.dataset.bracketRound), match = Number(card.dataset.bracketMatch);
        const target = cards.find(item => Number(item.dataset.bracketRound) === round + 1 && Number(item.dataset.bracketMatch) === Math.ceil(match / 2));
        if (!target) continue;
        const a = card.getBoundingClientRect(), b = target.getBoundingClientRect();
        const left = card.dataset.bracketSide === 'left';
        const x1 = (left ? a.right : a.left) - bounds.left;
        const x2 = (left ? b.left : b.right) - bounds.left;
        const y1 = a.top + a.height / 2 - bounds.top, y2 = b.top + b.height / 2 - bounds.top;
        const mid = (x1 + x2) / 2;
        paths.push({key: `${round}-${match}`, path: `M${x1},${y1} H${mid} V${y2} H${x2}`, own: Boolean(userId && card.dataset.winner === userId), complete: card.dataset.complete === 'true', x: mid, y: y1});
      }
      setLines(previous => {
        const next = {width: bounds.width, height: bounds.height, paths};
        return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
      });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    grid.querySelectorAll('[data-bracket-round]').forEach(card => observer.observe(card));
    measure();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fixtures, openingMatches, userId]);

  const final = fixtures.find(f => Number(f.round_number) === rounds);
  return <div className="knockout-stage hidden lg:block">
    <div aria-hidden="true" className="knockout-stage-orbit" />
    <div className="relative mb-7 flex items-center justify-center gap-3 text-[9px] font-bold tracking-[0.24em] text-amber-200/60">
      <span className="h-px w-12 bg-gradient-to-r from-transparent to-amber-400/40" /><Sparkles className="h-3.5 w-3.5" />ĐƯỜNG ĐẾN NGÔI VÔ ĐỊCH<Sparkles className="h-3.5 w-3.5" /><span className="h-px w-12 bg-gradient-to-l from-transparent to-amber-400/40" />
    </div>
    <div ref={gridRef} className="relative mx-auto grid w-full max-w-[1440px] items-stretch gap-x-3 gap-y-2" style={{gridTemplateColumns: `repeat(${rounds - 1}, minmax(0, 1fr)) minmax(0, 1.7fr) repeat(${rounds - 1}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${gridRows}, minmax(1.2rem, auto))`}}>
      {lines.width > 0 && <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${lines.width} ${lines.height}`} fill="none">
        {lines.paths.map(line => <g key={line.key} className={line.own ? 'bracket-route-own' : line.complete ? 'bracket-route-complete' : 'bracket-route-pending'}>
          <path d={line.path} stroke="currentColor" strokeWidth={line.own ? 2 : 1.25} strokeLinejoin="round" />
          <circle cx={line.x} cy={line.y} r={line.own ? 2.5 : 1.7} fill="currentColor" />
        </g>)}
      </svg>}
      {Array.from({length: rounds - 1}, (_, roundIndex) => {
        const round = roundIndex + 1, count = Math.ceil(openingMatches / 2 ** roundIndex), half = Math.ceil(count / 2);
        return Array.from({length: count}, (_, index) => {
          const fixture = fixtures.find(f => Number(f.round_number) === round && Number(f.match_number) === index + 1);
          const left = index < half;
          const rowSpan = 2 ** (roundIndex + 1), step = rowSpan * 2;
          const rowStart = (left ? index : index - half) * step + step / 4;
          const mine = Boolean(userId && [fixture?.player1_id, fixture?.player2_id].includes(userId));
          return <article key={`${round}-${index}`} data-bracket-round={round} data-bracket-match={index + 1} data-bracket-side={left ? 'left' : 'right'} data-winner={fixture?.winner_id || ''} data-complete={fixture?.status === 'completed'}
            className={`knockout-match relative z-10 self-center ${mine ? 'knockout-match-mine' : ''} ${fixture?.status === 'active' ? 'knockout-match-live' : ''}`}
            style={{gridColumn: left ? round : rounds * 2 - 1 - roundIndex, gridRow: `${rowStart} / span ${rowSpan}`}}>
            <div className="mb-2 flex items-center justify-between gap-1 text-[8px] font-bold uppercase tracking-wider">
              <span className="text-orange-300/90">{knockoutRoundLabel(openingMatches, round)}</span>
              <span className="rounded border border-purple-300/10 bg-purple-400/5 px-1.5 py-0.5 text-[7px] text-purple-200/60">{fixture?.series_best_of === 3 || !fixture ? 'BO3' : 'BO1'}</span>
            </div>
            {[1, 2].map(seat => {
              const id = fixture?.[`player${seat}_id`], name = fixture?.[`player${seat}`] || '?';
              const won = Boolean(id && fixture?.winner_id === id), own = Boolean(id && userId === id);
              return <div key={seat} className={`knockout-player ${won ? 'knockout-player-winner' : ''} ${own ? 'knockout-player-own' : ''}`}>
                <span className="flex min-w-0 items-center gap-1.5"><TournamentAvatar {...avatars.get(id)} name={name} /><span className="min-w-0 break-words text-xs leading-4 [overflow-wrap:anywhere]">{name}{own ? ' (Bạn)' : ''}</span></span>
                <strong className="knockout-score">{fixture?.series_best_of === 3 ? Number(fixture[`player${seat}_score`] || 0) : won ? '✓' : '–'}</strong>
              </div>;
            })}
            {fixture?.status === 'active' && <span className="mt-2 inline-flex items-center gap-1.5 text-[8px] font-bold text-amber-300"><span className="h-1 w-1 rounded-full bg-amber-300" />Đang thi đấu</span>}
          </article>;
        });
      })}
      <div className="relative z-10 flex min-w-0 flex-col gap-6 self-center" style={{gridColumn: rounds, gridRow: `1 / span ${gridRows}`}}>
        <KnockoutChampion final={final} avatars={avatars} userId={userId} />
        <article data-bracket-round={rounds} data-bracket-match="1" data-bracket-side="final" className="knockout-final-card">
          <KnockoutFinal final={final} userId={userId} />
        </article>
      </div>
    </div>
  </div>;
}
