export interface BackendUser {
  id: string;
  email: string;
  displayName: string;
  elo: number;
  highestElo?: number;
  avatarId?: PlayerAvatarId;
  avatarUrl?: string | null;
  profileBackgroundUrl?: string | null;
  profileBackgroundId?: (typeof PROFILE_BACKGROUNDS)[number]['id'];
  isAdmin?: boolean;
  activeBotVersion?: number;
}

export type PlayerAvatarId =
  | 'pumpkin'
  | 'ghost'
  | 'bat'
  | 'knight'
  | 'fox'
  | 'crown'
  | 'dragon'
  | 'cat'
  | 'wizard'
  | 'alien'
  | 'skull'
  | 'robot'
  | 'spider'
  | 'unicorn';

export const PLAYER_AVATARS: { id: PlayerAvatarId; emoji: string; label: string }[] = [
  { id: 'pumpkin', emoji: '🎃', label: 'Bí Ngô' },
  { id: 'ghost', emoji: '👻', label: 'Bóng Ma' },
  { id: 'bat', emoji: '🦇', label: 'Dơi Đêm' },
  { id: 'knight', emoji: '🛡️', label: 'Kỵ Sĩ' },
  { id: 'fox', emoji: '🦊', label: 'Cáo Lửa' },
  { id: 'crown', emoji: '👑', label: 'Quân Vương' },
  { id: 'dragon', emoji: '🐉', label: 'Rồng Lửa' },
  { id: 'cat', emoji: '🐱', label: 'Mèo Bí Ẩn' },
  { id: 'wizard', emoji: '🧙', label: 'Pháp Sư' },
  { id: 'alien', emoji: '👽', label: 'Sinh Vật Ngoài Hành Tinh' },
  { id: 'skull', emoji: '💀', label: 'Đầu Lâu' },
  { id: 'robot', emoji: '🤖', label: 'Người Máy' },
  { id: 'spider', emoji: '🕷️', label: 'Nhện Đêm' },
  { id: 'unicorn', emoji: '🦄', label: 'Kỳ Lân' },
];

export const PROFILE_BACKGROUNDS = [
  { id: 'castle', label: 'Lâu đài bí ngô', image: '/backgrounds/castle.svg' },
  { id: 'moonlight', label: 'Đêm trăng', image: '/backgrounds/moonlight.svg' },
  { id: 'emerald', label: 'Rừng huyền bí', image: '/backgrounds/emerald.svg' },
  { id: 'ocean', label: 'Vực sâu', image: '/backgrounds/ocean.svg' },
  { id: 'sunset', label: 'Hoàng hôn', image: '/backgrounds/sunset.svg' },
  { id: 'aurora', label: 'Cực quang', image: '/backgrounds/aurora.svg' },
  { id: 'crimson', label: 'Hỏa ngục', image: '/backgrounds/crimson.svg' },
  { id: 'ice', label: 'Băng giá', image: '/backgrounds/ice.svg' },
] as const;

export interface MatchSummary {
  id: string;
  seed: number;
  status: string;
  match_type?: 'human' | 'bot';
  tournament_phase?: 'practice' | 'ranked' | 'group' | 'knockout' | null;
  is_sparring?: boolean;
  winner_id: string | null;
  final_state_hash?: string | null;
  replay_sha256?: string | null;
  created_at: string;
  completed_at: string | null;
  replay_available: boolean;
  player1: string;
  player2: string;
  player1_id?: string;
  player2_id?: string;
  elo_before?: number | null;
  elo_after?: number | null;
  elo_delta?: number | null;
  elo_updated?: boolean;
}

export function getMatchFormatLabel(match: MatchSummary): string {
  return match.match_type === 'bot' ? 'Bot VS Bot' : 'Người VS Người';
}

export function getMatchEloLabel(match: MatchSummary, userId: string): string | null {
  const eloBefore =
    typeof match.elo_before === 'number' &&
    Number.isFinite(match.elo_before)
      ? match.elo_before
      : null;
  const eloAfter =
    typeof match.elo_after === 'number' && Number.isFinite(match.elo_after)
      ? match.elo_after
      : null;
  const hasEloRatings = eloBefore !== null && eloAfter !== null;
  const delta =
    typeof match.elo_delta === 'number' && Number.isFinite(match.elo_delta)
      ? match.elo_delta
      : hasEloRatings
      ? eloAfter - eloBefore
      : null;
  if (delta === null) return null;

  const signedDelta =
    delta > 0
      ? `+${delta}`
      : delta < 0
      ? `${delta}`
      : match.winner_id === userId
      ? '+0'
      : match.winner_id
      ? '-0'
      : '0';
  const ratingChange = hasEloRatings ? ` (${eloBefore} → ${eloAfter})` : '';
  return `${signedDelta} Elo${ratingChange}`;
}

export interface TournamentItem {
  min_elo?: number;
  knockout_starts_at?: string;
  knockout_started_at?: string;
  execution_mode?: 'browser' | 'server';
  id: string;
  name: string;
  format: string;
  description: string;
  status: 'scheduled' | 'registration' | 'grouping' | 'group_stage' | 'group_running' | 'group_complete' | 'knockout' | 'qualifying' | 'completed' | 'cancelled';
  registration_opens_at?: string;
  registration_closes_at: string;
  tournament_starts_at?: string;
  ends_at: string;
  max_teams: number;
  group_count?: number | null;
  current_week: number;
  total_sprints: number;
  week_started_at: string | null;
  rules_json: any;
  knockout_rules_json?: any;
  rules_schedule?: string[];
  participant_count?: number;
  created_at: string;
}

type EventHandler = (payload: any) => void;

export function resolveDefaultBackendUrl(): string {
  const envUrl = (import.meta.env?.VITE_BACKEND_URL as string | undefined)?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, '');
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:3000';
}

export class BackendClient {
  public baseUrl: string;
  public token: string | null = null;
  public user: BackendUser | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private handlers = new Map<string, Set<EventHandler>>();
  private activeMatchId: string | null = null;
  private pendingIceCandidates: any[] = [];
  private pendingMatchEvents = new Map<string, any[]>();

  constructor() {
    try {
      localStorage.removeItem('ottv2-backend-url');
    } catch {
      // ignore
    }
    this.baseUrl = resolveDefaultBackendUrl();
    this.restoreSession();
  }

  on(event: string, fn: EventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    const pending = this.pendingMatchEvents.get(event);
    if (pending?.length) {
      this.pendingMatchEvents.delete(event);
      queueMicrotask(() => {
        if (this.handlers.get(event)?.has(fn)) pending.forEach(packet => this.emit(event, packet));
      });
    }
    return () => {
      this.handlers.get(event)?.delete(fn);
    };
  }

  private emit(event: string, payload?: any) {
    const set = this.handlers.get(event);
    if (!set?.size) {
      if (event === 'peer-data' || event === 'peer-session-key') {
        const pending = this.pendingMatchEvents.get(event) || [];
        this.pendingMatchEvents.set(event, [...pending.slice(-63), payload]);
      }
      return;
    }
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`BackendClient listener error [${event}]:`, err);
      }
    }
  }

  restoreSession(): boolean {
    try {
      this.token = localStorage.getItem('ottv2-backend-token');
      const rawUser = localStorage.getItem('ottv2-backend-user');
      this.user = rawUser ? JSON.parse(rawUser) : null;
    } catch {
      this.token = null;
      this.user = null;
    }
    return Boolean(this.token && this.user);
  }

  saveSession(token: string, user: BackendUser) {
    this.token = token;
    this.user = user;
    try {
      localStorage.setItem('ottv2-backend-token', token);
      localStorage.setItem('ottv2-backend-user', JSON.stringify(user));
    } catch {
      // ignore
    }
    this.emit('auth-changed', user);
  }

  updateStoredUser(user: BackendUser) {
    this.user = user;
    try {
      localStorage.setItem('ottv2-backend-user', JSON.stringify(user));
    } catch {
      // ignore
    }
    this.emit('auth-changed', user);
  }

  clearSession() {
    this.closeSocket();
    this.token = null;
    this.user = null;
    try {
      localStorage.removeItem('ottv2-backend-token');
      localStorage.removeItem('ottv2-backend-user');
    } catch {
      // ignore
    }
    this.emit('auth-changed', null);
  }

  async checkHealth(): Promise<{ ok: boolean; latencyMs: number; mode?: string }> {
    const start = performance.now();
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      ok: Boolean(data?.ok),
      latencyMs: Math.round(performance.now() - start),
      mode: data?.mode,
    };
  }

  private async request(path: string, method = 'GET', body?: unknown, authRequired = false) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    else if (authRequired) throw new Error('Vui lòng đăng nhập trước khi thực hiện thao tác này.');

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Không thể kết nối tới máy chủ hệ thống. Vui lòng thử lại sau giây lát.');
    }

    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && authRequired) {
      this.clearSession();
      throw new Error(json.error || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    }
    if (!res.ok) {
      throw new Error(json.error || `Yêu cầu thất bại (${res.status})`);
    }
    return json;
  }

  async register(email: string, password: string, displayName: string) {
    const res = await this.request('/api/auth/register', 'POST', { email, password, displayName });
    this.saveSession(res.token, res.user);
    return res.user as BackendUser;
  }

  async login(email: string, password: string) {
    const res = await this.request('/api/auth/login', 'POST', { email, password });
    this.saveSession(res.token, res.user);
    return res.user as BackendUser;
  }

  async refreshMe() {
    if (!this.token) return null;
    const res = await this.request('/api/me', 'GET', undefined, true);
    if (res.user) this.updateStoredUser(res.user);
    return res.user as BackendUser;
  }

  async updateProfile(changes: {
    displayName?: string;
    avatarId?: PlayerAvatarId;
    avatarDataUrl?: string | null;
    profileBackgroundDataUrl?: string | null;
    profileBackgroundId?: (typeof PROFILE_BACKGROUNDS)[number]['id'];
    currentPassword?: string;
    newPassword?: string;
    confirmNewPassword?: string;
  }) {
    const res = await this.request('/api/me', 'PATCH', changes, true);
    if (res.user) this.updateStoredUser(res.user);
    return res.user as BackendUser;
  }

  async getLeaderboard(): Promise<Array<{ id: string; displayName: string; elo: number; avatarId?: PlayerAvatarId; avatarUrl?: string | null; isSystemBot?: boolean }>> {
    const res = await this.request('/api/leaderboard');
    return Array.isArray(res.players) ? res.players : [];
  }

  async getMatches(): Promise<MatchSummary[]> {
    if (!this.token) return [];
    const res = await this.request('/api/matches', 'GET', undefined, true);
    return Array.isArray(res.matches) ? res.matches : [];
  }

  async getMatchReplay(matchId: string) {
    const res = await this.request(`/api/matches/${encodeURIComponent(matchId)}/replay`);
    if (res.replay) return res.replay;
    if (res.downloadUrl) {
      const dl = await fetch(res.downloadUrl);
      if (!dl.ok) throw new Error('Không tải được file Replay.');
      return dl.json();
    }
    throw new Error('Không tìm thấy dữ liệu Replay.');
  }

  async getMyBot(): Promise<{ version: number; code: string; sha256: string; createdAt?: string }> {
    const res = await this.request('/api/bots/me', 'GET', undefined, true);
    return res.bot || { version: 0, code: '', sha256: '' };
  }

  async saveMyBot(code: string): Promise<{ version: number; sha256: string }> {
    const res = await this.request('/api/bots/me', 'POST', { code }, true);
    await this.refreshMe().catch(() => {});
    return res;
  }

  async getTournaments(): Promise<TournamentItem[]> {
    const res = await this.request('/api/tournaments');
    return Array.isArray(res.tournaments) ? res.tournaments : [];
  }

  async getTournamentDetail(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}`);
  }

  async getKnockoutNotices(): Promise<Array<{ id: string; name: string; knockout_starts_at?: string }>> {
    const res = await this.request('/api/me/knockout-notices', 'GET', undefined, true);
    return res.notices || [];
  }

  async getKnockoutMatches(id: string): Promise<any[]> {
    const res = await this.request(`/api/tournaments/${encodeURIComponent(id)}/knockout-matches`);
    return res.matches || [];
  }

  async createTournament(payload: {
    minElo?: number;
    name: string;
    description: string;
    registrationOpensAt: string;
    registrationClosesAt: string;
    tournamentStartsAt: string;
    blockedCells: number[];
    moveLimitRule: 'standard' | 'remaining-pieces' | 'goal-distance' | 'captured-points';
    capturedPieceValues: { rock: number; paper: number; scissors: number };
  }) {
    return this.request('/api/tournaments', 'POST', payload, true);
  }

  async createTournamentGroups(id: string, groupCount: number) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/groups`, 'POST', { groupCount }, true);
  }

  async startTournamentGroups(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/start-groups`, 'POST', {}, true);
  }

  async prepareTournamentKnockout(id: string, settings: any) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/prepare-knockout`, 'POST', settings, true);
  }

  async startTournamentKnockout(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/start-knockout`, 'POST', {}, true);
  }

  async cancelTournament(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/cancel`, 'POST', {}, true);
  }

  async cancelAllTournaments() {
    return this.request('/api/tournaments/cancel-all', 'POST', {}, true);
  }

  async startTournament(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/start`, 'POST', {}, true);
  }

  async advanceTournamentSprint(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/advance-sprint`, 'POST', {}, true);
  }

  async completeTournament(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/complete`, 'POST', {}, true);
  }

  async registerTournament(id: string) {
    return this.request(`/api/tournaments/${encodeURIComponent(id)}/register`, 'POST', {}, true);
  }

  async submitMatchResult(payload: unknown) {
    const res = await this.request('/api/match/submit-result', 'POST', payload, true);
    await this.refreshMe().catch(() => {});
    return res;
  }

  async forfeitMatch(matchId: string) {
    const res = await this.request('/api/match/forfeit', 'POST', { matchId }, true);
    await this.refreshMe().catch(() => {});
    return res;
  }

  async claimMatchTimeout(matchId: string, replay?: unknown) {
    const body = replay ? { matchId, replay } : { matchId };
    const res = await this.request('/api/match/claim-timeout', 'POST', body, true);
    if (res?.resolved) {
      await this.refreshMe().catch(() => {});
    }
    return res;
  }

  async submitConsensusDispute(payload: { report: unknown; evidence: unknown }) {
    const res = await this.request('/api/match/consensus-dispute', 'POST', payload, true);
    await this.refreshMe().catch(() => {});
    return res;
  }

  // ── WebSocket + Authenticated Match Relay Connection ──────────
  async connectWs(): Promise<void> {
    if (!this.token) throw new Error('Vui lòng đăng nhập trước khi kết nối máy chủ thi đấu.');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.ws = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Quá thời gian kết nối WebSocket máy chủ.'));
      }, 8000);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'auth', token: this.token }));
      });

      socket.addEventListener('message', (ev) => {
        let packet: any;
        try {
          packet = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (packet.type === 'authenticated') {
          clearTimeout(timeout);
          if (packet.user) this.updateStoredUser(packet.user);
          this.emit('ws-status', 'connected');
          resolve();
          return;
        }
        this.handleWsPacket(packet);
      });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Không thể thiết lập kết nối WebSocket tới máy chủ.'));
      });

      socket.addEventListener('close', () => {
        this.emit('ws-status', 'disconnected');
      });
    });
  }

  private handleWsPacket(packet: any) {
    if (packet.type === 'match-found') {
      this.pendingMatchEvents.clear();
      this.activeMatchId = packet.match?.id || null;
      this.closePeerChannel();
      this.emit('match-found', packet);
      return;
    }
    if (packet.type === 'signal') {
      this.handleWebRtcSignal(packet.payload).catch(() => {});
      return;
    }
    if (packet.type === 'match-relay') {
      if (packet.matchId !== this.activeMatchId) return;
      this.emit('peer-data', packet.payload);
      return;
    }
    if (packet.type === 'peer-session-key' && packet.matchId !== this.activeMatchId) return;
    this.emit(packet.type, packet);
  }

  private async handleWebRtcSignal(payload: any) {
    if (!this.pc || !payload || !this.activeMatchId) return;
    if (payload.description) {
      await this.pc.setRemoteDescription(payload.description);
      for (const cand of this.pendingIceCandidates) {
        try {
          await this.pc.addIceCandidate(cand);
        } catch {
          // ignore
        }
      }
      this.pendingIceCandidates = [];
      if (payload.description.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendWs({
          type: 'signal',
          matchId: this.activeMatchId,
          payload: { description: this.pc.localDescription },
        });
      }
    } else if (payload.candidate) {
      if (this.pc.remoteDescription) {
        try {
          await this.pc.addIceCandidate(payload.candidate);
        } catch {
          // ignore
        }
      } else {
        this.pendingIceCandidates.push(payload.candidate);
      }
    }
  }

  /**
   * Sends signed consensus message through authenticated WebSocket match-relay
   * so server-side signature verification and timeout tracking stay authoritative.
   */
  sendPeerMessage(matchId: string, payload: unknown, forceWsRelay = true) {
    if (!forceWsRelay && this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(payload));
      return;
    }
    this.sendWs({ type: 'match-relay', matchId, payload });
  }

  sendWs(packet: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Kết nối WebSocket máy chủ đã đóng.');
    }
    this.ws.send(JSON.stringify(packet));
  }

  async findHumanMatch() {
    await this.connectWs();
    this.sendWs({ type: 'find-match' });
  }

  async findBotMatch() {
    await this.connectWs();
    this.sendWs({ type: 'find-bot-match' });
  }

  async findTournamentMatch(tournamentId: string) {
    await this.connectWs();
    this.sendWs({ type: 'find-tournament-match', tournamentId });
  }

  async findSparringMatch(mode: 'human' | 'bot', tournamentId?: string) {
    await this.connectWs();
    this.sendWs({ type: 'find-sparring-match', mode, tournamentId });
  }

  cancelMatch() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWs({ type: 'cancel-match' });
    }
  }

  leaveMatchWs(matchId: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWs({ type: 'leave-match', matchId });
    }
  }

  registerSessionKey(matchId: string, publicKey: JsonWebKey) {
    this.sendWs({ type: 'session-key', matchId, publicKey });
  }

  abortBotSetup(matchId: string, message: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWs({ type: 'bot-setup-failed', matchId, message });
    }
  }

  reportBotFault(matchId: string, message: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendWs({ type: 'bot-fault', matchId, message });
    }
  }

  closePeerChannel() {
    this.pendingIceCandidates = [];
    if (this.dc) {
      try {
        this.dc.close();
      } catch {}
      this.dc = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
  }

  closeSocket() {
    this.closePeerChannel();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export const backendClient = new BackendClient();
