class SoundEngine {
  private ctx: AudioContext | null = null;
  public enabled = true;
  public volume = 0.6;

  constructor() {
    try {
      const saved = localStorage.getItem('ottv2-sound');
      if (saved !== null) this.enabled = saved !== 'off';
      const savedVolume = localStorage.getItem('ottv2-sound-volume');
      if (savedVolume !== null && Number.isFinite(Number(savedVolume))) {
        this.volume = Math.min(1, Math.max(0, Number(savedVolume)));
      }
    } catch {
      this.enabled = true;
    }
  }

  setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, value));
    try {
      localStorage.setItem('ottv2-sound-volume', String(this.volume));
    } catch {
      // ignore storage quota
    }
  }

  setEnabled(val: boolean) {
    this.enabled = val;
    try {
      localStorage.setItem('ottv2-sound', val ? 'on' : 'off');
    } catch {
      // ignore storage quota
    }
  }

  toggle(): boolean {
    const next = !this.enabled;
    this.setEnabled(next);
    return next;
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled || typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (Ctx) this.ctx = new Ctx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private tone(freq: number, duration: number, type: OscillatorType = 'sine', gainPeak = 0.08, delay = 0) {
    if (!this.enabled || this.volume <= 0) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak * this.volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playSelect() {
    this.tone(520, 0.06, 'triangle', 0.05);
  }

  playClick() {
    try {
      this.tone(640, 0.045, 'sine', 0.035);
      this.tone(920, 0.055, 'triangle', 0.015, 0.018);
    } catch {
      // Audio support must never prevent a button from working.
    }
  }

  playMove() {
    this.tone(360, 0.09, 'triangle', 0.07);
    this.tone(480, 0.08, 'sine', 0.04, 0.03);
  }

  playCapture() {
    this.tone(220, 0.14, 'sawtooth', 0.08);
    this.tone(587.33, 0.16, 'triangle', 0.09, 0.04);
  }

  playVictory() {
    this.tone(440, 0.16, 'triangle', 0.09, 0);
    this.tone(554.37, 0.16, 'triangle', 0.09, 0.11);
    this.tone(659.25, 0.22, 'triangle', 0.1, 0.22);
    this.tone(880, 0.35, 'sine', 0.11, 0.34);
  }

  playDefeat() {
    this.tone(392, 0.18, 'sawtooth', 0.06, 0);
    this.tone(349.23, 0.2, 'sawtooth', 0.06, 0.14);
    this.tone(293.66, 0.32, 'triangle', 0.07, 0.28);
  }
}

export const soundFx = new SoundEngine();
