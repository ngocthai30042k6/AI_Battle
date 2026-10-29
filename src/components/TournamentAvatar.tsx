import React from 'react';
import { PLAYER_AVATARS } from '../core/backendClient';

export function TournamentAvatar({ avatarId, avatarUrl, name }: {
  avatarId?: string; avatarUrl?: string | null; name: string;
}) {
  const avatar = PLAYER_AVATARS.find(item => item.id === avatarId) || PLAYER_AVATARS.find(item => item.id === 'pumpkin')!;
  return <span role="img" aria-label={`${name} avatar`} className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border-subtle)] bg-[var(--bg-panel)] text-[11px] leading-none">
    {avatar.emoji}
    {avatarUrl && <img src={avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
  </span>;
}
