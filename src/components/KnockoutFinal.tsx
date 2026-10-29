import React from 'react';
import { Crown, Trophy } from 'lucide-react';
import { orderedFinalists } from '../core/knockoutPresentation';

export function KnockoutFinal({ final, userId }: { final: any; userId?: string }) {
  const { players, decided } = orderedFinalists(final);
  return <div className="min-w-0 text-center">
    <Trophy className="mx-auto mb-2 h-7 w-7 text-[var(--accent-primary)]" />
    <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--accent-primary)]">Chung kết</h4>
    {players.map((player, index) => <React.Fragment key={player.id || index}>
      {index === 1 && <div className="my-3 text-sm font-bold text-[var(--accent-primary)]">{final?.series_best_of === 3 ? `${players[0].score}–${players[1].score} · BO3` : 'vs'}</div>}
      <div data-testid={decided ? index === 0 ? 'knockout-champion' : 'knockout-runner-up' : 'knockout-finalist'}
        className={`mt-4 min-w-0 font-black leading-tight [overflow-wrap:anywhere] ${decided ? index === 0 ? 'text-yellow-400' : 'text-slate-300' : 'text-[var(--text-primary)]'}`}
        style={{ fontSize: decided ? index === 0 ? '36px' : '24px' : '12px' }}>
        {decided && <Crown aria-label={index === 0 ? 'Vương miện vàng' : 'Vương miện bạc'} className="mr-2 inline-block align-middle" style={{ width: '1em', height: '1em' }} fill="currentColor" />}
        <span className={player.id && player.id === userId ? 'rounded bg-orange-500/15 px-1 underline decoration-orange-400 decoration-2 underline-offset-4' : ''}>{player.name}{player.id && player.id === userId ? ' (Bạn)' : ''}</span>
      </div>
      {decided && <p className={`mt-1 text-[10px] font-bold uppercase tracking-widest ${index === 0 ? 'text-yellow-500' : 'text-slate-400'}`}>{index === 0 ? 'Nhà vô địch' : 'Á quân'}</p>}
    </React.Fragment>)}
  </div>;
}
