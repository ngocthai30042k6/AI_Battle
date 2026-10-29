import React from 'react';
import { Crown, Trophy } from 'lucide-react';
import { orderedFinalists } from '../core/knockoutPresentation';

export function KnockoutFinal({ final, userId }: { final: any; userId?: string }) {
  const { players, decided } = orderedFinalists(final);
  return <div className={`knockout-podium relative isolate min-w-0 text-center ${decided ? 'knockout-podium-decided' : ''}`}>
    <div aria-hidden="true" className="knockout-podium-halo" />
    <svg aria-hidden="true" className="knockout-laurel knockout-laurel-left" viewBox="0 0 60 160" fill="none">
      <path d="M48 150C12 114 9 61 43 12" stroke="currentColor" strokeWidth="1.5" />
      {[0,1,2,3,4].map(index => <g key={index} transform={`translate(${index < 3 ? 0 : (index-2)*4} ${index*26})`}><path d="M27 29Q9 17 18 4Q31 12 27 29Z" fill="currentColor" /><path d="M26 36Q40 14 48 23Q43 38 26 36Z" fill="currentColor" /></g>)}
    </svg>
    <svg aria-hidden="true" className="knockout-laurel knockout-laurel-right" viewBox="0 0 60 160" fill="none"><path d="M48 150C12 114 9 61 43 12" stroke="currentColor" strokeWidth="1.5" />{[0,1,2,3,4].map(index => <g key={index} transform={`translate(${index < 3 ? 0 : (index-2)*4} ${index*26})`}><path d="M27 29Q9 17 18 4Q31 12 27 29Z" fill="currentColor" /><path d="M26 36Q40 14 48 23Q43 38 26 36Z" fill="currentColor" /></g>)}</svg>
    <div className="knockout-trophy-medallion"><Trophy className="h-8 w-8" strokeWidth={1.5} /></div>
    <h4 className="mt-4 text-[10px] font-black uppercase tracking-[0.24em] text-amber-200/90">Chung kết</h4>
    {players.map((player, index) => <React.Fragment key={player.id || index}>
      {index === 1 && <div className="knockout-final-score my-5 text-sm font-bold text-amber-200">{final?.series_best_of === 3 ? `${players[0].score}–${players[1].score} · BO3` : 'vs'}</div>}
      <div data-testid={decided ? index === 0 ? 'knockout-champion' : 'knockout-runner-up' : 'knockout-finalist'}
        className={`mt-5 min-w-0 font-black leading-tight [overflow-wrap:anywhere] ${decided ? index === 0 ? 'knockout-champion-name text-yellow-400' : 'text-slate-300' : 'text-[var(--text-primary)]'}`}
        style={{ fontSize: decided ? index === 0 ? '36px' : '24px' : '12px' }}>
        {decided && <Crown aria-label={index === 0 ? 'Vương miện vàng' : 'Vương miện bạc'} className="mr-2 inline-block align-middle" style={{ width: '1em', height: '1em' }} fill="currentColor" />}
        <span className={player.id && player.id === userId ? 'rounded bg-orange-500/15 px-1 underline decoration-orange-400 decoration-2 underline-offset-4' : ''}>{player.name}{player.id && player.id === userId ? ' (Bạn)' : ''}</span>
      </div>
      {decided && <p className={`mt-1 text-[10px] font-bold uppercase tracking-widest ${index === 0 ? 'text-yellow-500' : 'text-slate-400'}`}>{index === 0 ? 'Nhà vô địch' : 'Á quân'}</p>}
    </React.Fragment>)}
  </div>;
}
