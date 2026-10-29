import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Code2,
  Eye,
  Flame,
  LayoutDashboard,
  Menu,
  Radio,
  Settings,
  Swords,
  Trophy,
  User,
  X,
} from 'lucide-react';
import {
  backendClient,
  PLAYER_AVATARS,
  type BackendUser,
  type MatchSummary,
  type TournamentItem,
} from './core/backendClient';
import { SAMPLE_BOTS } from './core/sampleBots';
import { soundFx } from './core/soundFx';
import { backgroundMusic } from './core/backgroundMusic';
import { ToastProvider, useToast } from './components/ToastProvider';
import { HalloweenBackdrop } from './components/HalloweenBackdrop';
import { AppSettingsModal, type AppFont } from './components/AppSettingsModal';
import { AuthSettingsModal, type ModalTab } from './components/AuthSettingsModal';
import { ReplayModal } from './components/ReplayModal';
import { KnockoutQualificationNotice } from './components/KnockoutQualificationNotice';
import { ActiveMatchArena, type ActiveMatchSession } from './components/ActiveMatchArena';
import { OverviewView } from './views/OverviewView';
import { BotLabView } from './views/BotLabView';
import { MatchmakingView } from './views/MatchmakingView';
import { TournamentsView } from './views/TournamentsView';
import { PrivateRoomView } from './views/PrivateRoomView';
import { MultiWatchView } from './views/MultiWatchView';

type NavView =
  | 'overview'
  | 'bot-lab'
  | 'matchmaking'
  | 'tournaments'
  | 'private-room'
  | 'multi-watch';

const NAV_ITEMS: Array<{ id: NavView; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: 'overview', label: 'Tổng quan Sảnh', icon: LayoutDashboard },
  { id: 'bot-lab', label: 'Phòng Lab Bot Python', icon: Code2 },
  { id: 'matchmaking', label: 'Đấu trường Xếp hạng', icon: Swords },
  { id: 'tournaments', label: 'Giải đấu Sự kiện', icon: Trophy },
  { id: 'private-room', label: 'Phòng riêng P2P', icon: Radio },
  { id: 'multi-watch', label: 'Xem trực tiếp (4 Bàn)', icon: Eye },
];

const VIEW_TITLES: Record<NavView, string> = {
  overview: 'Sảnh Chiến Thuật OTTv2',
  'bot-lab': 'Phòng Lab & Huấn Luyện Bot Python 3',
  matchmaking: 'Đấu Trường Xếp Hạng Trực Tuyến',
  tournaments: 'Giải Đấu Bảng & Knock-out',
  'private-room': 'Phòng Đấu Riêng P2P',
  'multi-watch': 'Trung Tâm Xem Trực Tiếp 4 Bàn',
};

function AppWorkspace() {
  const { notify } = useToast();

  // Sound FX state
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => soundFx.enabled);
  const [soundVolume, setSoundVolume] = useState<number>(() => soundFx.volume);
  const [musicEnabled, setMusicEnabled] = useState<boolean>(() => backgroundMusic.enabled);
  const [musicVolume, setMusicVolume] = useState<number>(() => backgroundMusic.volume);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appFont, setAppFont] = useState<AppFont>(() => {
    try {
      const saved = localStorage.getItem('ottv2-font');
      return saved === 'outfit' || saved === 'system' ? saved : 'jakarta';
    } catch {
      return 'jakarta';
    }
  });

  useEffect(() => {
    const fontFamily =
      appFont === 'outfit'
        ? "'Outfit', system-ui, sans-serif"
        : appFont === 'system'
          ? "system-ui, -apple-system, 'Segoe UI', sans-serif"
          : "'Plus Jakarta Sans', system-ui, sans-serif";
    document.documentElement.style.setProperty('--app-font-family', fontFamily);
    try {
      localStorage.setItem('ottv2-font', appFont);
    } catch {
      // ignore storage quota
    }
  }, [appFont]);

  useEffect(() => {
    if (!musicEnabled) return;
    const unlockMusic = () => {
      backgroundMusic.setEnabled(true).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'Không thể khởi chạy nhạc nền.';
        setMusicEnabled(false);
        setMusicError(message);
      });
    };
    window.addEventListener('pointerdown', unlockMusic, { once: true });
    return () => window.removeEventListener('pointerdown', unlockMusic);
  }, [musicEnabled]);

  const handleSoundEnabledChange = (enabled: boolean) => {
    soundFx.setEnabled(enabled);
    setSoundEnabled(enabled);
  };
  const handleSoundVolumeChange = (volume: number) => {
    soundFx.setVolume(volume);
    setSoundVolume(volume);
  };
  const handleMusicEnabledChange = async (enabled: boolean) => {
    setMusicError(null);
    if (!enabled) {
      setMusicEnabled(false);
      await backgroundMusic.setEnabled(false);
      return;
    }

    try {
      await backgroundMusic.setEnabled(true);
      setMusicEnabled(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Không thể khởi chạy nhạc nền.';
      setMusicError(message);
      notify(message, 'error');
    }
  };
  const handleMusicVolumeChange = (volume: number) => {
    backgroundMusic.setVolume(volume);
    setMusicVolume(volume);
  };

  // Navigation & Responsive Drawer
  const [activeView, setActiveView] = useState<NavView>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // User, Bot & Dashboard Data
  const [user, setUser] = useState<BackendUser | null>(() => backendClient.user);
  const [editorCode, setEditorCode] = useState<string>(() => {
    try {
      return localStorage.getItem('ottv2-draft-bot-code') || SAMPLE_BOTS.phantom_hunter;
    } catch {
      return SAMPLE_BOTS.phantom_hunter;
    }
  });
  const [savedBotCode, setSavedBotCode] = useState<string>('');
  const [savedBotVersion, setSavedBotVersion] = useState<number>(user?.activeBotVersion || 0);

  const [leaderboard, setLeaderboard] = useState<
    Array<{
      id: string;
      displayName: string;
      elo: number;
      avatarId?: BackendUser['avatarId'];
      avatarUrl?: BackendUser['avatarUrl'];
      isSystemBot?: boolean;
    }>
  >([]);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [tournaments, setTournaments] = useState<TournamentItem[]>([]);
  const [loadingData, setLoadingData] = useState<boolean>(true);

  // Modals
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalTab, setAuthModalTab] = useState<ModalTab>('login');
  const [replayState, setReplayState] = useState<{
    open: boolean;
    data: any | null;
    p1: string;
    p2: string;
  }>({ open: false, data: null, p1: 'Player 1', p2: 'Player 2' });

  // Active 1v1 Match Session (Backend or P2P)
  const [activeMatch, setActiveMatch] = useState<ActiveMatchSession | null>(null);
  const [pendingTournamentId, setPendingTournamentId] = useState<string | null>(null);
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(null);
  const p2pCleanupRef = useRef<(() => void) | null>(null);

  const handleEditorCodeChange = (nextCode: string) => {
    setEditorCode(nextCode);
    try {
      localStorage.setItem('ottv2-draft-bot-code', nextCode);
    } catch {
      // ignore
    }
  };

  const refreshPublicAndUserData = useCallback(async () => {
    setLoadingData(true);
    try {
      const [lb, tours] = await Promise.all([
        backendClient.getLeaderboard().catch(() => []),
        backendClient.getTournaments().catch(() => []),
      ]);
      setLeaderboard(lb);
      setTournaments(tours);

      if (backendClient.token) {
        const [me, myMatches, myBot] = await Promise.all([
          backendClient.refreshMe().catch(() => null),
          backendClient.getMatches().catch(() => []),
          backendClient.getMyBot().catch(() => ({ version: 0, code: '', sha256: '' })),
        ]);
        setUser(me);
        setMatches(myMatches);
        setSavedBotVersion(myBot.version || 0);
        setSavedBotCode(myBot.code || '');
      } else {
        setMatches([]);
        setSavedBotVersion(0);
        setSavedBotCode('');
      }
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    refreshPublicAndUserData();
    const offAuth = backendClient.on('auth-changed', (nextUser) => {
      setUser(nextUser);
    });
    return () => offAuth();
  }, [refreshPublicAndUserData]);

  // Global listener for Backend Matchmaking `match-found`
  useEffect(() => {
    let pendingSparringMatchId: string | null = null;
    const offSpar = backendClient.on('sparring-ready', (pkt) => {
      pendingSparringMatchId = pkt.matchId || null;
    });

    const offMatchFound = backendClient.on('match-found', (pkt) => {
      const m = pkt.match;
      if (!m) return;
      const isSparring =
        Boolean(m.isSparring) ||
        pendingSparringMatchId === m.id ||
        pkt.opponent?.id === '00000000-0000-4000-8000-000000000001';

      setActiveMatch({
        source: 'backend',
        matchId: m.id,
        seed: m.seed,
        pieceCount: m.pieceCount || 9,
        mode: m.mode || 'bot',
        mySeat: pkt.seat,
        player1Name: m.player1?.displayName || 'Player 1',
        player2Name: m.player2?.displayName || 'Player 2',
        player1Elo: m.player1?.elo,
        player2Elo: m.player2?.elo,
        rules: m.rules || null,
        tournamentId: m.tournamentId || null,
        tournamentPhase: m.tournamentPhase || null,
        isSparring,
        lockedBotCode: pkt.myBotCode || pkt.tournamentBot?.code || null,
        lockedBotVersion: pkt.myBotVersion || pkt.tournamentBot?.version || 0,
      });
    });

    return () => {
      offSpar();
      offMatchFound();
    };
  }, []);

  const handleSaveBotToServer = async (code: string) => {
    try {
      const res = await backendClient.saveMyBot(code);
      setSavedBotCode(code);
      setSavedBotVersion(res.version);
      notify(`Đã lưu Bot Python phiên bản v${res.version} lên máy chủ!`, 'success');
    } catch (err: any) {
      notify(err.message || 'Không thể lưu mã Bot lên máy chủ.', 'error');
      throw err;
    }
  };

  const handleWatchReplayById = async (matchId: string, p1: string, p2: string) => {
    try {
      const replay = await backendClient.getMatchReplay(matchId);
      setReplayState({ open: true, data: replay, p1, p2 });
    } catch (err: any) {
      notify(err.message || 'Không tải được biên bản Replay của trận này.', 'error');
    }
  };

  const handleOpenAuth = (tab: ModalTab = 'login') => {
    setAuthModalTab(tab);
    setAuthModalOpen(true);
  };

  const handleExitActiveMatch = useCallback(() => {
    if (p2pCleanupRef.current) {
      p2pCleanupRef.current();
      p2pCleanupRef.current = null;
    }
    backendClient.closePeerChannel();
    setActiveMatch(null);
    refreshPublicAndUserData();
  }, [refreshPublicAndUserData]);

  return (
    <div className="relative h-screen flex overflow-hidden text-[var(--text-primary)]">
      {/* Full-Viewport Dark Fantasy Castle, Pumpkin Lanterns & Drifting Fireflies */}
      <HalloweenBackdrop />

      {/* Desktop Persistent Sidebar */}
      <aside className="relative z-20 hidden h-screen shrink-0 border-r border-[var(--border-subtle)] bg-[#120c1e]/85 backdrop-blur-md lg:sticky lg:top-0 lg:flex lg:w-64 lg:flex-col">
        <div className="h-16 px-6 flex items-center border-b border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => {
              if (!activeMatch) setActiveView('overview');
            }}
            className="flex items-center gap-2.5 text-left cursor-pointer"
          >
            <div className="w-8 h-8 rounded-xl bg-[var(--p1-bg)] border border-[var(--p1-border)] flex items-center justify-center text-[var(--accent-primary)]">
              <Flame className="w-4 h-4" />
            </div>
            <span className="font-display font-extrabold text-lg tracking-tight text-[var(--text-primary)] whitespace-nowrap">
              OTTv2 Arena
            </span>
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = !activeMatch && activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                disabled={Boolean(activeMatch)}
                onClick={() => setActiveView(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-45 ${
                  active
                    ? 'bg-[var(--bg-panel)] text-[var(--text-primary)] border border-[var(--border-accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    active ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'
                  }`}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* App settings at the bottom of the sidebar */}
        <div className="p-4 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors cursor-pointer whitespace-nowrap"
          >
            <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
            Cài đặt
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/75 lg:hidden"
        >
          <div
            className="w-72 h-full bg-[#150e23] border-r border-[var(--border-subtle)] p-4 flex flex-col justify-between"
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
                <span className="font-display font-bold text-base text-[var(--text-primary)]">
                  OTTv2 Arena
                </span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-1.5 rounded-lg text-[var(--text-secondary)]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <nav className="space-y-1">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const active = !activeMatch && activeView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={Boolean(activeMatch)}
                      onClick={() => {
                        setActiveView(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium ${
                        active
                          ? 'bg-[var(--bg-panel)] text-[var(--text-primary)] border border-[var(--border-accent)]'
                          : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            <div className="pt-4 border-t border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setSettingsOpen(true);
                }}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-medium border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--text-primary)]"
              >
                <Settings className="w-4 h-4 text-[var(--accent-primary)]" />
                Cài đặt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="relative z-10 flex h-screen min-h-0 min-w-0 flex-1 flex-col">
        {/* Clean Single-Row Top Header */}
        <header className="h-16 shrink-0 px-4 sm:px-8 border-b border-[var(--border-subtle)] bg-[#120c1e]/80 backdrop-blur-md flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Mở menu điều hướng"
              className="lg:hidden p-2 rounded-xl border border-[var(--border-subtle)] text-[var(--text-secondary)]"
            >
              <Menu className="w-5 h-5" />
            </button>
            {!activeMatch && activeView !== 'overview' && (
              <button
                type="button"
                onClick={() => setActiveView('overview')}
                aria-label="Quay lại Sảnh"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] px-2.5 py-2 text-xs font-semibold text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] sm:px-3"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Quay lại Sảnh</span>
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold text-[var(--text-primary)] truncate">
              {activeMatch ? 'Bàn Thi Đấu Chiến Thuật 9×9' : VIEW_TITLES[activeView]}
            </h1>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => handleOpenAuth(user ? 'profile' : 'login')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] transition-colors cursor-pointer whitespace-nowrap shrink-0 tabular-nums"
            >
              {user ? (
                user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                ) : (
                  <span aria-hidden="true">
                    {PLAYER_AVATARS.find((avatar) => avatar.id === (user.avatarId || 'pumpkin'))?.emoji || '🎃'}
                  </span>
                )
              ) : (
                <User className="w-3.5 h-3.5" />
              )}
              {user ? `${user.displayName} · ${user.elo}` : 'Đăng nhập/Đăng kí'}
            </button>
          </div>
        </header>

        {/* Page Viewport */}
        <main className="min-h-0 flex-1 overflow-y-auto w-full max-w-[1320px] mx-auto px-4 sm:px-8 py-6 sm:py-8">
          {activeMatch ? (
            <ActiveMatchArena
              session={activeMatch}
              customEditorCode={editorCode}
              savedBotCode={savedBotCode}
              hasSavedBot={savedBotVersion > 0 && Boolean(savedBotCode.trim())}
              themeMode="halloween"
              onExit={handleExitActiveMatch}
              onOpenReplay={(data, p1, p2) => setReplayState({ open: true, data, p1, p2 })}
            />
          ) : (
            <>
              {activeView === 'overview' && (
                <OverviewView
                  user={user}
                  botVersion={savedBotVersion}
                  leaderboard={leaderboard}
                  recentMatches={matches}
                  tournaments={tournaments}
                  loadingData={loadingData}
                  onNavigate={(v) => setActiveView(v)}
                  onOpenTournament={(id) => {
                    setPendingTournamentId(id);
                    setActiveView('tournaments');
                  }}
                  onOpenAuth={(tab) => handleOpenAuth(tab || 'login')}
                  onWatchMatchReplay={(m) => handleWatchReplayById(m.id, m.player1, m.player2)}
                />
              )}

              {activeView === 'bot-lab' && (
                <BotLabView
                  user={user}
                  themeMode="halloween"
                  editorCode={editorCode}
                  onEditorCodeChange={handleEditorCodeChange}
                  savedBotVersion={savedBotVersion}
                  onSaveBotToServer={handleSaveBotToServer}
                  onOpenAuth={(tab) => handleOpenAuth(tab || 'login')}
                />
              )}

              {activeView === 'matchmaking' && (
                <MatchmakingView
                  user={user}
                  savedBotVersion={savedBotVersion}
                  matches={matches}
                  onRefreshMatches={refreshPublicAndUserData}
                  onOpenAuth={(tab) => handleOpenAuth(tab || 'login')}
                  onWatchMatchReplay={(m) => handleWatchReplayById(m.id, m.player1, m.player2)}
                />
              )}

              {activeView === 'tournaments' && (
                <TournamentsView
                  user={user}
                  savedBotVersion={savedBotVersion}
                  themeMode="halloween"
                  tournaments={tournaments}
                  initialSelectedId={pendingTournamentId || selectedTournamentId}
                  onClearInitialSelectedId={() => setPendingTournamentId(null)}
                  onSelectionChange={setSelectedTournamentId}
                  onRefreshTournaments={refreshPublicAndUserData}
                  onOpenAuth={(tab) => handleOpenAuth(tab || 'login')}
                  onOpenBotLab={(tournamentId) => {
                    if (tournamentId) setPendingTournamentId(tournamentId);
                    setActiveView('bot-lab');
                  }}
                  onWatchReplayById={handleWatchReplayById}
                />
              )}

              {activeView === 'private-room' && (
                <PrivateRoomView
                  user={user}
                  savedBotCode={savedBotCode}
                  savedBotVersion={savedBotVersion}
                  onLaunchMatch={(session, cleanupFn) => {
                    p2pCleanupRef.current = cleanupFn || null;
                    setActiveMatch(session);
                  }}
                />
              )}

              {activeView === 'multi-watch' && <MultiWatchView themeMode="halloween" />}
            </>
          )}
        </main>
      </div>

      {/* Auth & Player Profile Modal */}
      <AuthSettingsModal
        open={authModalOpen}
        initialTab={authModalTab}
        user={user}
        matches={matches}
        onClose={() => setAuthModalOpen(false)}
        onWatchMatchReplay={(match) =>
          handleWatchReplayById(match.id, match.player1, match.player2)
        }
        onUserUpdated={(nextUser) => {
          setUser(nextUser);
          refreshPublicAndUserData();
        }}
      />

      {/* SHA-256 Verified Replay Modal */}
      <KnockoutQualificationNotice userId={user?.id} onOpenTournament={id => { setSelectedTournamentId(id); setActiveView('tournaments'); }} />
      <ReplayModal
        open={replayState.open}
        replayData={replayState.data}
        player1Name={replayState.p1}
        player2Name={replayState.p2}
        themeMode="halloween"
        onClose={() => setReplayState((prev) => ({ ...prev, open: false }))}
      />

      <AppSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        font={appFont}
        onFontChange={setAppFont}
        musicEnabled={musicEnabled}
        onMusicEnabledChange={handleMusicEnabledChange}
        musicError={musicError}
        musicVolume={musicVolume}
        onMusicVolumeChange={handleMusicVolumeChange}
        soundEnabled={soundEnabled}
        onSoundEnabledChange={handleSoundEnabledChange}
        soundVolume={soundVolume}
        onSoundVolumeChange={handleSoundVolumeChange}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppWorkspace />
    </ToastProvider>
  );
}
