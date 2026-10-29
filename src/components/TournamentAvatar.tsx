import React from 'react';
import { PLAYER_AVATARS } from '../core/backendClient';

export function TournamentAvatar({ avatarId, avatarUrl, name, size = 'small' }: {
  avatarId?: string; avatarUrl?: string | null; name: string; size?: 'small' | 'medium' | 'large';
}) {
  const avatar = PLAYER_AVATARS.find(item => item.id === avatarId) || PLAYER_AVATARS.find(item => item.id === 'pumpkin')!;
  const sizing = { small:'h-5 w-5 text-[11px]', medium:'h-10 w-10 text-xl', large:'h-20 w-20 text-4xl' }[size];
  return <span role="img" aria-label={`${name} avatar`} className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] leading-none ${sizing}`}>
    {avatar.emoji}
    {avatarUrl && <img src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
  </span>;
}
