import React from 'react';
import { Crown } from 'lucide-react';
import { orderedFinalists } from '../core/knockoutPresentation';
import { TournamentAvatar } from './TournamentAvatar';

export function KnockoutChampion({ final, avatars, userId }: {
  final:any; avatars:Map<string,{avatarId?:string;avatarUrl?:string|null}>; userId?:string;
}) {
  const {players,decided}=orderedFinalists(final);
  if (!decided) return null;
  const champion=players[0];
  return <div aria-label="Nhà vô địch giải đấu" className="relative mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl border border-amber-300/20 bg-gradient-to-b from-amber-300/10 to-transparent px-4 py-5 text-center">
    <div className="relative rounded-full p-1 ring-1 ring-amber-300/60 shadow-[0_0_35px_rgba(251,191,36,0.18)]">
      <TournamentAvatar {...avatars.get(champion.id)} name={champion.name} size="large" />
      <Crown aria-hidden="true" className="absolute -right-1 -top-2 h-7 w-7 -rotate-12 text-yellow-400 drop-shadow-lg" fill="currentColor" />
    </div>
    <div>
      <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.25em] text-amber-200/75">Nhà vô địch</p>
      <p className="knockout-champion-name break-words text-2xl font-black leading-tight text-yellow-400 [overflow-wrap:anywhere] sm:text-3xl">
        {champion.name}{champion.id===userId ? ' (Bạn)' : ''}
      </p>
    </div>
  </div>;
}
