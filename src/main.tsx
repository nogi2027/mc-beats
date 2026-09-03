import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { drumNames, Instrument, Parameter, DrumModel } from './audio';
import { createAppEngine } from './engine-factory';
import type { AudioEngine } from './synth/contract';
import { DeckInstrument, DeckRecorder, DECK_TICKS, EIGHTH_NOTE_TICKS, RecordMode, safeTempo, type DeckSnapshot, type QuantizeDivision, type SingleDeck } from './deck';
import { MusicController } from './music-controller';
import type { DeckId, TransferStyle } from './music-types';
import { registerWebMcp } from './webmcp';
import { KeyboardPressRegistry, type KeyboardPress } from './keyboard-input';
import { SPECTRUM_COLUMNS, SPECTRUM_MAX_FREQUENCY, SPECTRUM_MIN_FREQUENCY, SPECTRUM_ROWS, type FrequencyHistogramRecorder } from './frequency-history';
import { ENVELOPE_FIELDS, envelopeDisplayBounds, envelopeDisplayValue, envelopeParameterValue, type EnvelopeFieldKey } from './envelope-controls';
import { envelopePath, envelopePreviewGeometry, type EnvelopePreviewValues } from './envelope-preview';
import { buildLeadKeyboardLayout } from './lead-keyboard';
import { chordVisualKey, playbackVisuals } from './playback-visuals';
import { PLATTER_COAST_MS, platterAngleDegrees, platterCoastTicks, platterResumeOffset, shortestPlatterOffset, wrapPlatterTick } from './platter-motion';
import { beginSwitchDirection, updateSwitchDirection, type SwitchDirectionState } from './switch-direction';
import { MUSIC_PRESETS } from './music-catalog';
import { deckPhasePosition, deckPhaseTick } from './deck-phase';
import './styles.css';

const presets = MUSIC_PRESETS;
const defaults: Record<Instrument, string[]> = {
  drums: ['Punch', 'Tightness', 'Dirt', 'Room'], bass: ['Tone', 'Shape', 'Glide', 'Drive'],
  chords: ['Tone', 'Attack', 'Width', 'Space'], lead: ['Tone', 'Bite', 'Motion', 'Echo'],
  metronome: ['Tone', 'Attack', 'Decay', 'Level'],
};
const parameterGroups: Record<Instrument, { label: string; names: string[] }[]> = {
  drums: [
    { label: 'Kick', names: ['kickStartHz', 'kickEndHz', 'kickPitchFallMs', 'kickDecayMs', 'kickClickHz', 'kickClickMs', 'kickClickLevel'] },
    { label: 'Snare', names: ['snareBodyHz', 'snareBodyMs', 'snareNoiseHz', 'snareNoiseMs', 'snareNoiseLevel'] },
    { label: 'Hats', names: ['closedHatMs', 'closedHatFilterHz', 'closedHatLevel', 'openHatMs', 'openHatFilterHz', 'openHatNoiseLevel', 'openHatMetalLevel'] },
    { label: 'Clap', names: ['clapGapMs', 'clapBurstMs', 'clapTailMs', 'clapFilterHz', 'clapCrackLevel', 'clapTailLevel'] },
    { label: 'Toms', names: ['tomFallMs', 'tomLowStartHz', 'tomLowEndHz', 'tomHighStartHz', 'tomHighEndHz', 'tomNoiseLevel'] },
    { label: 'Percussion', names: ['percAHz', 'percBHz'] },
    { label: 'Rim', names: ['rimHz', 'rimDecayMs', 'rimFilterHz', 'rimNoiseLevel'] },
    { label: 'Shaker', names: ['shakerMs', 'shakerLevel', 'shakerFilterHz', 'shakerAttackMs', 'shakerFilterQ'] },
    { label: 'Cowbell', names: ['cowbellHzA', 'cowbellHzB', 'cowbellDecayMs', 'cowbellFilterHz', 'cowbellNoiseLevel'] },
    { label: 'Ride', names: ['rideMs', 'rideLevel', 'rideFilterHz'] },
  ],
  bass: [{ label: 'Synthesis', names: ['subLevel', 'filterHz', 'attackMs', 'decayMs', 'sustainLevel', 'dwellMs', 'releaseMs', 'subOctave', 'clickHz', 'clickLevel', 'glideMs'] }],
  chords: [{ label: 'Synthesis', names: ['attackMs', 'decayMs', 'sustainLevel', 'releaseMs', 'detuneCents', 'filterHz', 'oscillatorMix', 'harmonicLevel', 'chorusMs', 'delayMs'] }],
  lead: [{ label: 'Synthesis', names: ['attackMs', 'decayMs', 'sustainLevel', 'releaseMs', 'filterHz', 'detuneCents', 'vibratoHz', 'vibratoCents', 'chorusDelayMs', 'chorusDepthMs', 'chorusRateHz', 'chorusMix', 'echoMs', 'echoFeedback'] }],
  metronome: [{ label: 'Synthesis', names: ['clickHz', 'accentHz', 'attackMs', 'decayMs', 'clickLevel', 'filterHz'] }],
};
const bassKeys = [36, 38, 41, 43, 46, 48, 50, 53];
const leadKeys = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84];
const keyMap: Record<string, number> = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72, o: 73, l: 74, p: 75, ';': 76 };
const keyboardKeys = Object.keys(keyMap);
const drumKeyboardMap = keyboardKeys.map((_, index) => index % drumNames.length);
type Theme = 'light' | 'dark';
const initialTheme = (): Theme => {
  try {
    const saved = window.localStorage.getItem('mc-beats-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage can be unavailable */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const bassKeyboardMap = keyboardKeys.map((key) => keyMap[key] - 24);
const chordKeyboardRoots = [48, 50, 52, 53, 55, 57, 58, 59, 60, 62, 64, 65, 67, 69, 70, 71];
const chordQualities = [
  { id: 'major', label: 'Major', intervals: [0, 4, 7] },
  { id: 'minor', label: 'Minor', intervals: [0, 3, 7] },
  { id: 'dominant7', label: 'Dominant 7', intervals: [0, 4, 7, 10] },
  { id: 'major7', label: 'Major 7', intervals: [0, 4, 7, 11] },
  { id: 'minor7', label: 'Minor 7', intervals: [0, 3, 7, 10] },
  { id: 'sus2', label: 'Sus 2', intervals: [0, 2, 7] },
  { id: 'sus4', label: 'Sus 4', intervals: [0, 5, 7] },
  { id: 'diminished7', label: 'Diminished 7', intervals: [0, 3, 6, 9] },
] as const;
const chordRoots = [
  { label: 'C', midi: 48 }, { label: 'D', midi: 50 }, { label: 'E', midi: 52 }, { label: 'F', midi: 53 },
  { label: 'G', midi: 55 }, { label: 'A', midi: 57 }, { label: 'Bb', midi: 58 }, { label: 'B', midi: 59 },
];
const inversionLabels = ['Root', '1st inversion', '2nd inversion', '3rd inversion'];
const inversionVoicings = ['root', 'first-inversion', 'second-inversion', 'third-inversion'] as const;
const noteNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const whiteKeyRoots = [0, 2, 4, 5, 7, 9, 11];
const pinkKeyRoots = [{ root: 1, left: 14.286 }, { root: 3, left: 28.571 }, { root: 6, left: 57.143 }, { root: 8, left: 71.429 }, { root: 10, left: 85.714 }];
const scaleIntervals = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 11] } as const;
const scaleRomans = { major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'], minor: ['i', 'ii°', 'III', 'iv', 'V', 'VI', 'vii°'] } as const;
const noteName = (midi: number) => noteNames[((midi % 12) + 12) % 12];
const buildScaleMidi = (root: number, mode: 'major' | 'minor', base: number, count: number) => Array.from({ length: count }, (_, index) => base + root + scaleIntervals[mode][index % 7] + Math.floor(index / 7) * 12);
const buildDiatonicChords = (root: number, mode: 'major' | 'minor') => {
  const scale = buildScaleMidi(root, mode, 48, 14);
  return Array.from({ length: 7 }, (_, degree) => {
    const pitches = [scale[degree], scale[degree + 2], scale[degree + 4]];
    const minorThird = pitches[1] - pitches[0] === 3;
    const diminished = pitches[2] - pitches[0] === 6;
    return { roman: scaleRomans[mode][degree], symbol: `${noteName(pitches[0])}${diminished ? 'dim' : minorThird ? 'm' : ''}`, root: pitches[0], pitches, voicing: 'root' as const };
  });
};
const drumShortcutKeys = ['1', '2', '3', 'q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];
const bassShortcutKeys = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"];
const chordShortcutKeys = ['1', '2', '3', '4', '5', '6', '7'];
const isBpmEntryTarget = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return element?.tagName === 'INPUT' && element.getAttribute('aria-label') === 'Tempo';
};
const switchEffects: Array<{ label: string; style: TransferStyle }> = [{ label: 'CROSSFADE', style: 'blend' }, { label: 'CUT', style: 'cut' }, { label: 'DIP', style: 'dip' }, { label: 'OVERLAP', style: 'overlap' }];
const quantizeOptions: QuantizeDivision[] = ['off', '1/4', '1/8', '1/16'];
type PointerVoice =
  | { kind: 'note'; id: string; instrument: 'bass' | 'lead'; midi: number }
  | { kind: 'chord'; id: string; root: number };
type KeyboardVoice = { instrument: DeckInstrument; id: string; midi?: number; root?: number; pitches?: number[]; symbol?: string; voicing?: typeof inversionVoicings[number] };
const appCleanupHandlers = new Set<() => void>();
import.meta.hot?.dispose(() => {
  appCleanupHandlers.forEach((cleanup) => cleanup());
  appCleanupHandlers.clear();
});
const buildChordPitches = (root: number, quality: typeof chordQualities[number], inversion: number) => {
  const notes = quality.intervals.map((interval) => root + interval);
  const moves = Math.min(Math.max(0, inversion), notes.length - 1);
  for (let i = 0; i < moves; i++) notes.push(notes.shift()! + 12);
  return notes;
};
const chordName = (root: number, quality: typeof chordQualities[number], inversion: number) => {
  const rootLabel = chordRoots.find((item) => item.midi === root)?.label ?? `MIDI ${root}`;
  return `${rootLabel} ${quality.label}${inversion ? ` · ${inversionLabels[inversion]}` : ''}`;
};

const clampProgress = (value: number) => Math.max(0, Math.min(1, value));

function TransportIcon({ playing }: { playing: boolean }) {
  return <svg className="transport-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {playing
      ? <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>
      : <path d="M7 4.5 18 12 7 19.5Z" />}
  </svg>;
}

function StatusProgress({ progress, readLiveProgress }: { progress: number; readLiveProgress?: () => number }) {
  const fill = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!readLiveProgress) return;
    let frame = 0;
    const paint = () => {
      if (fill.current) fill.current.style.transform = `scaleX(${clampProgress(readLiveProgress())})`;
      frame = window.requestAnimationFrame(paint);
    };
    paint();
    return () => window.cancelAnimationFrame(frame);
  }, [readLiveProgress]);

  return <span className="status-progress"><i ref={fill} style={{ transform: `scaleX(${clampProgress(progress)})` }} /></span>;
}

function IntroModal({ onClose, scale }: { onClose: () => void; scale: number }) {
  const compact = scale < .75;
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const [fitScale, setFitScale] = useState(compact ? Math.min(1, Math.max(.4, scale * 1.7)) : 1);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const modal = modalRef.current;
    if (!backdrop || !modal) return;
    const fit = () => {
      const backdropStyle = getComputedStyle(backdrop);
      const availableWidth = backdrop.clientWidth - parseFloat(backdropStyle.paddingLeft) - parseFloat(backdropStyle.paddingRight);
      const availableHeight = backdrop.clientHeight - parseFloat(backdropStyle.paddingTop) - parseFloat(backdropStyle.paddingBottom);
      const widthScale = availableWidth / Math.max(1, modal.offsetWidth);
      const heightScale = availableHeight / Math.max(1, modal.offsetHeight);
      setFitScale(Math.min(1, widthScale, heightScale));
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(backdrop);
    observer?.observe(modal);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [compact]);

  useEffect(() => {
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeWithEscape);
    return () => document.removeEventListener('keydown', closeWithEscape);
  }, [onClose]);

  return <div ref={backdropRef} className="intro-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={modalRef} className={`intro-modal ${compact ? 'intro-compact' : ''}`} style={{ '--intro-scale': fitScale } as CSSProperties} role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <button className="intro-close" type="button" aria-label="Close introduction" onClick={onClose}>×</button>
      <h1 id="intro-title">Welcome to MC Beats</h1>
      <p className="intro-capabilities">MC Beats is a live procedural synth with <span className="intro-instrument intro-drums">drums</span>, <span className="intro-instrument intro-bass">bass</span>, <span className="intro-instrument intro-chords">chords</span>, and <span className="intro-instrument intro-lead">lead</span>. All sound is synthesized from oscillators and procedural noise; there are no samples.</p>
      <p className="intro-lead-in">There are three ways to interact with MC Beats.</p>
      <div className="intro-sections">
        <section>
          <h2><span>1.</span> Play it yourself</h2>
          <p>Click any pad, key, or keyboard shortcut to play the focused instrument. Click another instrument to put it into focus. Choose presets and adjust the controls or envelope settings. Use Record, or press <kbd>R</kbd>, to capture a four-bar take on the active deck. Play the active deck with the <span className="intro-transport-icons"><TransportIcon playing={false} /><TransportIcon playing /></span> Play/Pause button or the <kbd>Space</kbd> bar. Switch decks with the large slider.</p>
        </section>
        <section>
          <h2><span>2.</span> Get your agent to play</h2>
          <p>In an MCP-enabled browser, ask your agent to create a <em>groove</em> in the active deck, or prepare one in the inactive deck. Ask it to transfer between decks, change sound presets, or turn instruments on and off. It can also <span className="intro-solo">solo</span> over the groove for extra sparkle.</p>
        </section>
        <section>
          <h2><span>3.</span> Play with your agent</h2>
          <p>Play live while your agent builds or changes material in the background. Try requests such as “Add a <span className="intro-instrument intro-bass">bass</span> pattern to Deck B at the next bar” or “Create a <span className="intro-instrument intro-lead">lead</span> <span className="intro-solo">solo</span> over the next four bars.” It can see what you are playing and join in at the right time and on the right beat.</p>
        </section>
      </div>
      <button className="intro-start" type="button" onClick={onClose}>START PLAYING</button>
    </section>
  </div>;
}

function App() {
  const [engine] = useState<AudioEngine>(() => createAppEngine(window.location.search));
  const [music] = useState(() => new MusicController(engine));
  const [showIntro, setShowIntro] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [playing, setPlaying] = useState(false);
  const [tick, setTick] = useState(0);
  const [resumeToken, setResumeToken] = useState(0);
  const subscribeMusic = useCallback((listener: () => void) => music.subscribe(listener), [music]);
  const readActiveDeck = useCallback(() => music.getActiveDeck(), [music]);
  const activeDeck = useSyncExternalStore(subscribeMusic, readActiveDeck, readActiveDeck);
  const [focusedInstrument, setFocusedInstrument] = useState<DeckInstrument>('lead');
  const [recordMode, setRecordMode] = useState<RecordMode>('overdub');
  const [chordQuality, setChordQuality] = useState('major');
  const [chordInversion, setChordInversion] = useState(0);
  const [recording, setRecording] = useState(false);
  const [lastTake, setLastTake] = useState('No take committed');
  const [keyModeDraft, setKeyModeDraft] = useState(1);
  const [crossfadeDraft, setCrossfadeDraft] = useState(0);
  const [humanSwitching, setHumanSwitching] = useState(false);
  const [switchDestination, setSwitchDestination] = useState<DeckId>('B');
  const switchDirection = useRef<SwitchDirectionState>({ destination: 'B', extreme: 0 });
  const [pressedShortcuts, setPressedShortcuts] = useState<Set<string>>(() => new Set());
  const [uiScale, setUiScale] = useState(() => Math.min(1, Math.max(1, window.innerWidth - 32) / 1440));
  const [, redraw] = useState(0);
  const recordingTimer = useRef<number | null>(null);
  const metronomeBeforeRecording = useRef(false);
  const deck = music.decks.A;
  const deckB = music.decks.B;
  const [deckRecorders] = useState(() => ({
    A: new DeckRecorder(() => engine.context, () => engine.tempo, deck),
    B: new DeckRecorder(() => engine.context, () => engine.tempo, deckB),
  }));
  const deckRecorder = deckRecorders[activeDeck];
  const activeDeckData = activeDeck === 'A' ? deck : deckB;
  const keyboardPresses = useRef(new KeyboardPressRegistry<KeyboardVoice>());
  const pointerVoices = useRef(new Map<number, PointerVoice>());
  const keySetting = useRef<HTMLDetailsElement>(null);
  const keyModeDragging = useRef(false);
  const selectedChordQuality = chordQualities.find((quality) => quality.id === chordQuality) ?? chordQualities[0];
  const effectiveChordInversion = Math.min(chordInversion, selectedChordQuality.intervals.length - 1);
  const musicState = music.getState({ includeExecutedCues: true, includeLiveEvents: false });
  const { tempo, keyRoot, keyMode, quantize, metronomeEnabled: metronomeOn, switchEffect } = musicState.projectSettings;
  const selected = musicState.liveSound.presetIndexes;
  const started = musicState.audio.state === 'running';
  const transportPlaying = musicState.clock.running;
  const countInPositionTick = deckRecorder.countInPositionTick();
  const visualPhaseTick = deckPhaseTick(musicState.clock.deckPhaseTick, countInPositionTick);
  const phaseTickRef = useRef(musicState.clock.deckPhaseTick);
  phaseTickRef.current = musicState.clock.deckPhaseTick;
  const readPlatterTick = useCallback(() => deckRecorder.countInPositionTick() ?? phaseTickRef.current, [deckRecorder]);
  const visualPosition = deckPhasePosition(visualPhaseTick);
  const readTransferProgress = useCallback(() => music.getState({ includeExecutedCues: false, includeLiveEvents: false }).transfer?.progress ?? 1, [music]);
  const playingVisuals = playbackVisuals({ decks: musicState.decks, phaseTick: visualPhaseTick, absoluteTick: musicState.clock.absoluteTick, crossfadePosition: musicState.crossfadePosition, solo: musicState.solo, playing: transportPlaying });
  const playingClass = (instrument: 'drums' | 'bass' | 'lead' | 'chords', value: number | string) => {
    if (!musicState.instrumentEnabled[instrument]) return '';
    const deckMutedForReplace = recording && recordMode === 'replace' && focusedInstrument === instrument;
    const deckActive = !deckMutedForReplace && playingVisuals.deck[instrument].has(value as never);
    const soloActive = playingVisuals.solo[instrument].has(value as never);
    return `${deckActive || soloActive ? ' deck-playing-note' : ''}${soloActive ? ' ai-playing-note' : ''}`;
  };
  const chordPads = buildDiatonicChords(keyRoot, keyMode);
  const bassUiKeys = buildScaleMidi(keyRoot, keyMode, 36, 11);
  const leadKeyboard = buildLeadKeyboardLayout(keyRoot, keyMode);
  const keyLabel = `${noteNames[keyRoot]}${keyMode === 'minor' ? 'm' : ''}`;

  const finishKeyMode = (value: number) => {
    const snapped = value >= .5 ? 1 : 0;
    keyModeDragging.current = false;
    setKeyModeDraft(snapped);
    music.setProjectSettings({ keyMode: snapped === 1 ? 'minor' : 'major' });
  };

  useEffect(() => {
    const closeKeyPicker = (event: globalThis.PointerEvent) => {
      const details = keySetting.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    const closeKeyPickerWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && keySetting.current?.open) {
        keySetting.current.open = false;
        keySetting.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeKeyPicker);
    document.addEventListener('keydown', closeKeyPickerWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeKeyPicker);
      document.removeEventListener('keydown', closeKeyPickerWithEscape);
    };
  }, []);

  useEffect(() => {
    if (!transportPlaying && musicState.solo?.status !== 'active') return;
    let frame = 0;
    let lastPaint = 0;
    const animatePlayback = (time: number) => {
      if (time - lastPaint >= 30) {
        lastPaint = time;
        redraw((value) => value + 1);
      }
      frame = window.requestAnimationFrame(animatePlayback);
    };
    frame = window.requestAnimationFrame(animatePlayback);
    return () => window.cancelAnimationFrame(frame);
  }, [transportPlaying, musicState.solo?.status]);

  useEffect(() => {
    const fit = () => setUiScale(Math.min(1, Math.max(1, window.innerWidth - 32) / 1440));
    window.addEventListener('resize', fit);
    fit();
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.synthMode = (engine as AudioEngine & { mode?: string }).mode === 'hybrid' ? 'hybrid' : 'legacy';
    return () => { delete document.documentElement.dataset.synthMode; };
  }, [engine]);

  useEffect(() => { const unsubscribe = music.subscribe(() => redraw((n) => n + 1)); return () => { unsubscribe(); }; }, [music]);

  const previousTransportRunning = useRef(musicState.clock.running);
  useEffect(() => {
    if (musicState.clock.running && !previousTransportRunning.current) setResumeToken((token) => token + 1);
    previousTransportRunning.current = musicState.clock.running;
  }, [musicState.clock.running]);

  useEffect(() => {
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (recordingTimer.current !== null) {
        window.clearInterval(recordingTimer.current);
        recordingTimer.current = null;
      }
      deckRecorders.A.cancel();
      deckRecorders.B.cancel();
      (['drums', 'bass', 'chords', 'lead'] as DeckInstrument[]).forEach((instrument) => music.setRecordingInstrumentMuted(instrument, false));
      pointerVoices.current.forEach((voice) => engine.releaseNote(voice.id));
      pointerVoices.current.clear();
      keyboardPresses.current.values().forEach((entry) => {
        if (entry.status === 'started' && entry.value.instrument !== 'drums') engine.releaseNote(entry.value.id);
      });
      keyboardPresses.current.clear();
      engine.heldNotes.forEach((_, id) => engine.releaseNote(id));
      music.clearHumanHeldSilently();
      music.dispose();
    };
    appCleanupHandlers.add(cleanup);
    return () => {
      appCleanupHandlers.delete(cleanup);
      cleanup();
    };
  }, [deckRecorders, engine, music]);

  useEffect(() => {
    let alive = true;
    let unregister: (() => void) | null = null;
    const cleanup = () => { alive = false; unregister?.(); unregister = null; };
    appCleanupHandlers.add(cleanup);
    void registerWebMcp(music).then((registrationCleanup) => { if (alive) unregister = registrationCleanup; else registrationCleanup(); });
    return () => { appCleanupHandlers.delete(cleanup); cleanup(); };
  }, [music]);

  useEffect(() => {
    if (chordInversion !== effectiveChordInversion) setChordInversion(effectiveChordInversion);
  }, [chordInversion, effectiveChordInversion]);

  useEffect(() => {
    (Object.keys(presets) as Instrument[]).forEach((instrument) => music.setLiveSound({ instrument, presetId: presets[instrument][0] }));
  }, [music]);

  useEffect(() => {
    const down = async (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const activeKeys = focusedInstrument === 'drums' ? drumShortcutKeys : focusedInstrument === 'bass' ? bassShortcutKeys : focusedInstrument === 'chords' ? chordShortcutKeys : leadKeyboard.shortcuts;
      const index = activeKeys.indexOf(key);
      if (event.repeat || index < 0 || keyboardPresses.current.has(key) || isBpmEntryTarget(event.target)) return;
      const id = focusedInstrument === 'chords' ? `keyboard-chord-${key}` : `keyboard-${key}`;
      const value: KeyboardVoice = focusedInstrument === 'drums'
        ? { instrument: 'drums', id }
        : focusedInstrument === 'chords'
          ? { instrument: 'chords', id, root: chordPads[index].root, pitches: [...chordPads[index].pitches], symbol: chordPads[index].symbol, voicing: chordPads[index].voicing }
          : { instrument: focusedInstrument, id, midi: focusedInstrument === 'lead' ? leadKeyboard.midiByShortcut[key] : bassUiKeys[index] };
      const press = keyboardPresses.current.reserve(key, value);
      if (!press) return;
      setPressedShortcuts((current) => new Set(current).add(key));
      let startedResult: Awaited<ReturnType<typeof start>>;
      try {
        startedResult = await start();
      } catch {
        keyboardPresses.current.take(key);
        setPressedShortcuts((current) => { const next = new Set(current); next.delete(key); return next; });
        return;
      }
      if (!startedResult.ok || !keyboardPresses.current.isCurrent(press)) {
        if (keyboardPresses.current.isCurrent(press)) keyboardPresses.current.take(key);
        setPressedShortcuts((current) => { const next = new Set(current); next.delete(key); return next; });
        return;
      }
      const at = engine.context?.currentTime;
      if (at === undefined || !keyboardPresses.current.markStarted(press)) {
        if (keyboardPresses.current.isCurrent(press)) keyboardPresses.current.take(key);
        setPressedShortcuts((current) => { const next = new Set(current); next.delete(key); return next; });
        return;
      }
      if (press.value.instrument === 'drums') {
        const pad = drumKeyboardMap[index];
        engine.drum(pad, at);
        music.humanDrumHit(pad, 1, at);
        deckRecorder.recordDrum(pad, 1, at);
      } else if (press.value.instrument === 'chords') {
        const root = press.value.root!;
        const pitches = press.value.pitches!;
        engine.holdChord(id, pitches);
        music.humanChordOn(id, press.value.symbol!, pitches, press.value.voicing!, 1, at);
        deckRecorder.recordChordOn(id, press.value.symbol!, pitches, press.value.voicing!, at);
      } else {
        const midi = press.value.midi!;
        engine.holdNote(id, press.value.instrument, midi);
        music.humanNoteOn(id, press.value.instrument, midi, 1, at);
        deckRecorder.recordNoteOn(press.value.instrument, id, midi, 1, at);
      }
      redraw((n) => n + 1);
    };
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const pressed = keyboardPresses.current.take(key);
      setPressedShortcuts((current) => { const next = new Set(current); next.delete(key); return next; });
      if (!pressed || pressed.status === 'pending') return;
      const at = engine.context?.currentTime;
      if (pressed.value.instrument === 'chords') {
        engine.releaseNote(pressed.value.id);
        music.humanChordOff(pressed.value.id, at);
        if (at !== undefined) deckRecorder.recordChordOff(pressed.value.id, at);
      } else if (pressed.value.instrument !== 'drums') {
        engine.releaseNote(pressed.value.id);
        music.humanNoteOff(pressed.value.id, at);
        if (at !== undefined && pressed.value.midi !== undefined) deckRecorder.recordNoteOff(pressed.value.instrument, pressed.value.id, at);
      }
      redraw((n) => n + 1);
    };
    const releaseAllKeyboard = () => {
      const at = engine.context?.currentTime;
      const pressed = keyboardPresses.current.values();
      keyboardPresses.current.clear();
      setPressedShortcuts(new Set());
      pressed.forEach((entry: KeyboardPress<KeyboardVoice>) => {
        if (entry.status === 'pending' || entry.value.instrument === 'drums') return;
        engine.releaseNote(entry.value.id);
        if (at === undefined) return;
        if (entry.value.instrument === 'chords') { music.humanChordOff(entry.value.id, at); deckRecorder.recordChordOff(entry.value.id, at); }
        else if (entry.value.midi !== undefined) { music.humanNoteOff(entry.value.id, at); deckRecorder.recordNoteOff(entry.value.instrument, entry.value.id, at); }
      });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAllKeyboard);
    document.addEventListener('visibilitychange', releaseAllKeyboard);
    window.addEventListener('pagehide', releaseAllKeyboard);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAllKeyboard);
      document.removeEventListener('visibilitychange', releaseAllKeyboard);
      window.removeEventListener('pagehide', releaseAllKeyboard);
    };
  }, [focusedInstrument, deckRecorder, keyRoot, keyMode]);

  useEffect(() => {
    deckRecorders.A.setQuantization(quantize);
    deckRecorders.B.setQuantization(quantize);
  }, [deckRecorders, quantize]);

  const start = async () => {
    if (engine.context?.state === 'running') {
      return { ok: true, code: 'AUDIO_ALREADY_STARTED', message: 'Audio is already running.', data: { started: true, state: engine.context.state } } as const;
    }
    return music.startAudio();
  };
  const switchDeck = (nextDeck: DeckId) => {
    if (recording) return;
    music.selectActiveDeck(nextDeck);
    redraw((n) => n + 1);
  };
  const transferDeck = (nextDeck: DeckId) => {
    if (recording || nextDeck === activeDeck) return;
    if (!musicState.clock.running) {
      switchDeck(nextDeck);
      return;
    }
    music.queueAction({ when: 'next-bar' }, {
      type: 'transfer-deck',
      destination: nextDeck,
      style: switchEffect,
      durationTicks: switchEffect === 'cut' ? 0 : EIGHTH_NOTE_TICKS * 8,
    });
    redraw((n) => n + 1);
  };
  const updateCrossfade = (value: number) => {
    const nextDirection = updateSwitchDirection(switchDirection.current, value);
    switchDirection.current = nextDirection;
    setSwitchDestination((current) => current === nextDirection.destination ? current : nextDirection.destination);
    setCrossfadeDraft(value);
    music.setCrossfader(value, switchEffect);
    redraw((n) => n + 1);
  };
  const finishCrossfade = (value: number) => {
    const snapped = value < .5 ? 0 : 1;
    music.setCrossfader(snapped, switchEffect);
    setCrossfadeDraft(snapped);
    setHumanSwitching(false);
    redraw((n) => n + 1);
  };
  const toggleRecordMode = () => setRecordMode((mode) => mode === 'overdub' ? 'replace' : 'overdub');
  useEffect(() => {
    if (!humanSwitching) return;
    const finishInterrupted = () => finishCrossfade(crossfadeDraft);
    const finishWhenHidden = () => { if (document.hidden) finishInterrupted(); };
    window.addEventListener('blur', finishInterrupted);
    document.addEventListener('visibilitychange', finishWhenHidden);
    return () => {
      window.removeEventListener('blur', finishInterrupted);
      document.removeEventListener('visibilitychange', finishWhenHidden);
    };
  }, [humanSwitching, crossfadeDraft]);
  const toggleInstrument = (instrument: DeckInstrument) => {
    music.humanSetInstrumentEnabled(instrument, !musicState.instrumentEnabled[instrument]);
    redraw((n) => n + 1);
  };
  const seedDeckFor = (target: SingleDeck) => {
    const eighth = EIGHTH_NOTE_TICKS;
    target.clear();
    target.addDrum(0, 0); target.addDrum(0, 8 * eighth);
    [4, 12].forEach((tickAt) => target.addDrum(1, tickAt * eighth));
    [2, 6, 10, 14].forEach((tickAt) => target.addDrum(2, tickAt * eighth, .7));
    target.addNote('bass', 36, 0, 4 * eighth); target.addNote('bass', 41, 4 * eighth, 4 * eighth);
    target.addNote('bass', 43, 8 * eighth, 4 * eighth); target.addNote('bass', 36, 12 * eighth, 4 * eighth);
    target.addChord('C major', [48, 52, 55, 60], 0, 4 * eighth);
    target.addChord('F major', [53, 57, 60, 65], 4 * eighth, 4 * eighth);
    target.addChord('G major', [55, 59, 62, 67], 8 * eighth, 4 * eighth);
    target.addChord('C major', [48, 52, 55, 60], 12 * eighth, 4 * eighth);
    [60, 64, 67, 72].forEach((pitch, index) => target.addNote('lead', pitch, (index * 2 + 1) * eighth, eighth));
  };
  const seedDeck = () => {
    music.humanMutateDeck('A', seedDeckFor);
    redraw((n) => n + 1);
  };
  const seedDeckB = () => { music.humanMutateDeck('B', seedDeckFor); redraw((n) => n + 1); };
  const toggleDeck = async () => {
    if (recording) {
      cancelRecording();
      music.stopTransport();
      return;
    }
    const audio = await start();
    if (!audio.ok) return;
    if (musicState.clock.running) {
      music.stopTransport();
      return;
    }
    await music.startTransport();
  };
  const clearDeck = () => {
    music.stopTransport();
    music.clearDeck('A');
    redraw((n) => n + 1);
  };
  const clearDeckB = () => {
    music.stopTransport();
    music.clearDeck('B');
    redraw((n) => n + 1);
  };
  const beginRecording = async () => {
    const audio = await start();
    if (!audio.ok) return;
    if (deckRecorder.begin(focusedInstrument, recordMode, 4)) {
      music.setHumanRecording(true, activeDeck, focusedInstrument);
      const recordingStartAt = deckRecorder.recordingStartAt();
      const recordingTransport = music.startRecordingTransport(recordingStartAt, focusedInstrument, recordMode === 'replace');
      if (!recordingTransport.ok) {
        deckRecorder.cancel();
        music.setHumanRecording(false);
        setLastTake(`${recordingTransport.code}: ${recordingTransport.message}`);
        return;
      }
      metronomeBeforeRecording.current = metronomeOn;
      music.setProjectSettings({ metronomeEnabled: true });
      setRecording(true);
      setLastTake(`Recording ${focusedInstrument}${recordMode === 'replace' ? ' (deck track muted)' : ' (overdub)'}`);
      recordingTimer.current = window.setInterval(() => {
        if (deckRecorder.recordingTicks() >= DECK_TICKS) commitRecording();
      }, 25);
    }
  };
  const commitRecording = () => {
    if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
    recordingTimer.current = null;
    const take = deckRecorder.buildTake();
    setRecording(false);
    if (take) {
      if (take.count > 0) {
        const committed = music.commitHumanRecording(activeDeck, take, engine.getSoundProfile(take.instrument, presets[take.instrument][selected[take.instrument]]));
        music.setRecordingInstrumentMuted(take.instrument, false);
        if (!committed.ok) { music.setHumanRecording(false); setLastTake(`${committed.code}: ${committed.message}`); return; }
        music.catchUpRecordingEvents(activeDeck, take.instrument, committed.data?.added ?? []);
      } else {
        music.setHumanRecording(false);
        music.setRecordingInstrumentMuted(take.instrument, false);
      }
      setLastTake(`${take.count} ${take.instrument} event${take.count === 1 ? '' : 's'} committed (${take.mode})`);
      music.setProjectSettings({ metronomeEnabled: metronomeBeforeRecording.current });
      redraw((n) => n + 1);
    }
  };
  const cancelRecording = () => { if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current); recordingTimer.current = null; const target = deckRecorder.targetInstrument(); deckRecorder.cancel(); music.setHumanRecording(false); music.setRecordingInstrumentMuted(target, false); setRecording(false); music.setProjectSettings({ metronomeEnabled: metronomeBeforeRecording.current }); setLastTake('Take cancelled'); };
  useEffect(() => {
    const performanceShortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isBpmEntryTarget(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        event.stopPropagation();
        void toggleDeck();
        return;
      }
      if (event.key.toLowerCase() !== 'r') return;
      event.preventDefault();
      event.stopPropagation();
      if (recording) commitRecording();
      else void beginRecording();
    };
    window.addEventListener('keydown', performanceShortcut, true);
    return () => window.removeEventListener('keydown', performanceShortcut, true);
  });
  const updateTempo = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const updated = music.setProjectSettings({ tempo: value });
    if (!updated.ok) return;
    if (deckRecorder.isRecording()) {
      deckRecorder.retime();
      music.retimeRecordingTransport(deckRecorder.recordingStartAt());
    }
  };
  const triggerDrum = async (index: number) => { await start(); const at = engine.context!.currentTime; engine.drum(index, at); music.humanDrumHit(index, 1, at); deckRecorder.recordDrum(index, 1, at); };
  const triggerNote = async (instrument: 'bass' | 'lead', midi: number, id = `${instrument}-${midi}`, pointerId?: number) => {
    await start();
    if (pointerId !== undefined && pointerVoices.current.get(pointerId)?.id !== id) return;
    const at = engine.context?.currentTime;
    if (at === undefined) return;
    engine.holdNote(id, instrument, midi);
    music.humanNoteOn(id, instrument, midi, 1, at);
    deckRecorder.recordNoteOn(instrument, id, midi, 1, at);
  };
  const triggerChord = async (root: number, id = `chord-${root}`, pointerId?: number) => {
    await start();
    if (pointerId !== undefined && pointerVoices.current.get(pointerId)?.id !== id) return;
    const at = engine.context!.currentTime;
    const pitches = buildChordPitches(root, selectedChordQuality, effectiveChordInversion);
    engine.holdChord(id, pitches);
    music.humanChordOn(id, chordName(root, selectedChordQuality, effectiveChordInversion), pitches, inversionVoicings[effectiveChordInversion], 1, at);
    deckRecorder.recordChordOn(id, chordName(root, selectedChordQuality, effectiveChordInversion), pitches, inversionVoicings[effectiveChordInversion], at);
  };
  const releasePointerVoice = (pointerId: number, target?: HTMLButtonElement) => {
    const voice = pointerVoices.current.get(pointerId);
    if (!voice) return;
    pointerVoices.current.delete(pointerId);
    if (target?.hasPointerCapture(pointerId)) {
      try { target.releasePointerCapture(pointerId); } catch { /* capture already lost */ }
    }
    const at = engine.context?.currentTime;
    engine.releaseNote(voice.id);
    if (voice.kind === 'chord') music.humanChordOff(voice.id, at);
    else music.humanNoteOff(voice.id, at);
    if (at === undefined) return;
    if (voice.kind === 'chord') deckRecorder.recordChordOff(voice.id, at);
    else deckRecorder.recordNoteOff(voice.instrument, voice.id, at);
  };
  const startPointerVoice = (event: ReactPointerEvent<HTMLButtonElement>, voice: PointerVoice) => {
    event.preventDefault();
    releasePointerVoice(event.pointerId);
    pointerVoices.current.set(event.pointerId, voice);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture is not available */ }
    if (voice.kind === 'chord') void triggerChord(voice.root, voice.id, event.pointerId);
    else void triggerNote(voice.instrument, voice.midi, voice.id, event.pointerId);
  };
  const runPattern = async () => {
    await start(); setPlaying(true); setTick(0);
    const step = 60 / safeTempo(tempo) / 2;
    const startAt = engine.context!.currentTime + .05;
    for (let i = 0; i < 32; i++) {
      const at = startAt + i * step;
      engine.drum(i % 8, at);
      if (i % 4 === 0) engine.note('bass', [36, 36, 41, 43][(i / 4) % 4], .35, at);
      window.setTimeout(() => { setTick(i + 1); if (i === 31) setPlaying(false); }, (i * step + .05) * 1000);
    }
  };

  const currentBar = visualPosition.bar + 1;
  const currentBeat = visualPosition.beat + 1;
  const statusCopy = recording
    ? (deckRecorder.countInBeat() ? `COUNT IN · ${deckRecorder.countInBeat()} / 4` : `RECORDING ${focusedInstrument.toUpperCase()}`)
    : musicState.solo?.status === 'active'
      ? `SOLO · ${musicState.solo.instrument.toUpperCase()}`
      : humanSwitching || musicState.transfer?.status === 'active'
        ? `SWITCHING TO DECK ${humanSwitching ? switchDestination : musicState.transfer?.destination ?? activeDeck}`
      : `DECK ${activeDeck} · 4 BAR LOOP`;
  const countInBeat = deckRecorder.countInBeat();
  const statusMode = recording ? 'recording' : musicState.solo?.status === 'active' ? 'solo' : humanSwitching || musicState.transfer?.status === 'active' ? 'switching' : 'counting';
  const statusProgress = countInBeat ? countInBeat / 4 : statusMode === 'switching' ? (humanSwitching ? crossfadeDraft : musicState.transfer?.progress ?? musicState.crossfadePosition) : musicState.clock.deckPhaseTick / DECK_TICKS;
  const liveSwitchProgress = statusMode === 'switching' && !humanSwitching;
  const switchingDecks = humanSwitching || musicState.transfer?.status === 'active';
  const platterIsMoving = (deckId: DeckId) => transportPlaying && (deckId === activeDeck || switchingDecks);
  const platterCrossfade = humanSwitching ? crossfadeDraft : musicState.crossfadePosition;
  const setPresetFor = (instrument: Instrument) => (value: number) => {
    music.setLiveSound({ instrument, presetId: presets[instrument][value] });
  };
  const sharedPanelProps = (instrument: DeckInstrument) => ({
    instrument,
    focused: focusedInstrument === instrument,
    onFocus: () => setFocusedInstrument(instrument),
    presets: presets[instrument],
    selected: selected[instrument],
    setPreset: setPresetFor(instrument),
    engine,
    music,
    redraw,
    enabled: musicState.instrumentEnabled[instrument],
    pendingToggle: musicState.instrumentControls[instrument].nextCue,
    onToggle: () => toggleInstrument(instrument),
    locked: recording && focusedInstrument !== instrument,
  });

  useEffect(() => {
    try { window.localStorage.setItem('mc-beats-theme', theme); } catch { /* storage can be unavailable */ }
  }, [theme]);

  return <div className="app-viewport" data-theme={theme} style={{ width: 1440 * uiScale, height: 940 * uiScale }}>
    <main className="mc-page" style={{ transform: `scale(${uiScale})` }}>
      <section className="console" aria-label="MC Beats performance console">
        <section className="deck-section">
          <aside className="project-rail">
            <div className="wordmark">MC<br />BEATS</div>
          </aside>
          <aside className="deck-rail switch-rail">
            <label className={`deck-toggle ${musicState.transfer?.status === 'active' ? 'agent-moving' : ''}`}><span>B</span><input type="range" aria-label="Deck crossfader" min="0" max="1" step=".01" value={humanSwitching ? crossfadeDraft : musicState.crossfadePosition} disabled={recording} onPointerDown={(event) => { void start(); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unavailable */ } const direction = beginSwitchDirection(activeDeck, musicState.crossfadePosition); switchDirection.current = direction; setSwitchDestination(direction.destination); setCrossfadeDraft(musicState.crossfadePosition); setHumanSwitching(true); }} onChange={(event) => updateCrossfade(event.currentTarget.valueAsNumber)} onPointerUp={(event) => finishCrossfade(event.currentTarget.valueAsNumber)} onPointerCancel={(event) => finishCrossfade(event.currentTarget.valueAsNumber)} onLostPointerCapture={(event) => { if (humanSwitching) finishCrossfade(event.currentTarget.valueAsNumber); }} onKeyDown={(event) => { const next = event.key === 'Home' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? 0 : event.key === 'End' || event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : null; if (next !== null) { event.preventDefault(); finishCrossfade(next); } }} /><span>A</span></label>
            <details className="effect-switch"><summary aria-label={`Switch effect: ${switchEffect}`}><span>SWITCH FX</span><strong>{switchEffects.find((effect) => effect.style === switchEffect)?.label}</strong><i aria-hidden="true">⌄</i></summary><div className="switch-menu">{switchEffects.map((effect) => <button type="button" key={effect.style} onClick={(event) => { music.setProjectSettings({ switchEffect: effect.style }); const details = event.currentTarget.closest('details'); if (details) details.open = false; }}>{effect.label}</button>)}</div></details>
          </aside>
          <div className="platters">
            <DeckPlatter deck="A" snapshot={deck.snapshot()} activity={1 - platterCrossfade} playing={platterIsMoving('A')} resumeToken={resumeToken} countingIn={activeDeck === 'A' && countInBeat !== null} readPhaseTick={readPlatterTick} enabled={musicState.instrumentEnabled} tempo={tempo} />
            <DeckPlatter deck="B" snapshot={deckB.snapshot()} activity={platterCrossfade} playing={platterIsMoving('B')} resumeToken={resumeToken} countingIn={activeDeck === 'B' && countInBeat !== null} readPhaseTick={readPlatterTick} enabled={musicState.instrumentEnabled} tempo={tempo} />
            <div className="deck-meta" aria-label="Deck performance settings">
              <button className="theme-setting" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} aria-pressed={theme === 'dark'} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}><span className={theme === 'light' ? 'active' : ''}>LIGHT</span><i aria-hidden="true" /><span className={theme === 'dark' ? 'active' : ''}>DARK</span></button>
              <label><input aria-label="Tempo" type="number" step="20" value={tempo} onChange={(event) => updateTempo(event.currentTarget.valueAsNumber)} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); updateTempo(tempo + (event.key === 'ArrowUp' ? 20 : -20)); } else if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /><small>BPM</small></label>
              <details ref={keySetting} className="deck-setting key-setting" onToggle={(event) => { if (event.currentTarget.open) setKeyModeDraft(keyMode === 'minor' ? 1 : 0); }}><summary><b>{keyLabel}</b><small>KEY</small></summary><div className="key-picker"><strong>{noteNames[keyRoot]} {keyMode.toUpperCase()}</strong><div className="key-root-dots" role="group" aria-label="Key tonic">{whiteKeyRoots.map((root, index) => <button type="button" className={`key-root-dot white-root ${root === keyRoot ? 'selected' : ''}`} style={{ left: `${(index + .5) / 7 * 100}%` }} aria-label={`${noteNames[root]} tonic`} aria-pressed={root === keyRoot} key={root} onClick={() => music.setProjectSettings({ keyRoot: root })}>{noteNames[root]}</button>)}{pinkKeyRoots.map(({ root, left }) => <button type="button" className={`key-root-dot pink-root ${root === keyRoot ? 'selected' : ''}`} style={{ left: `${left}%` }} aria-label={`${noteNames[root]} tonic`} aria-pressed={root === keyRoot} key={root} onClick={() => music.setProjectSettings({ keyRoot: root })}>{noteNames[root]}</button>)}</div><label className="key-mode-switch"><span className={keyModeDraft < .5 ? 'active' : ''}>MAJOR</span><input type="range" aria-label="Key mode" min="0" max="1" step=".01" value={keyModeDraft} onPointerDown={(event) => { keyModeDragging.current = true; try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unavailable */ } }} onChange={(event) => setKeyModeDraft(event.currentTarget.valueAsNumber)} onPointerUp={(event) => finishKeyMode(event.currentTarget.valueAsNumber)} onPointerCancel={() => { keyModeDragging.current = false; setKeyModeDraft(keyMode === 'minor' ? 1 : 0); }} onLostPointerCapture={(event) => { if (keyModeDragging.current) finishKeyMode(event.currentTarget.valueAsNumber); }} onKeyDown={(event) => { const value = event.key === 'Home' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? 0 : event.key === 'End' || event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : null; if (value !== null) { event.preventDefault(); finishKeyMode(value); } }} /><span className={keyModeDraft >= .5 ? 'active' : ''}>MINOR</span></label></div></details>
              <details className="deck-setting"><summary><b>{quantize.toUpperCase()}</b><small>QUANTISE</small></summary><div className="deck-setting-menu">{quantizeOptions.map((option) => <button type="button" className={option === quantize ? 'selected' : ''} key={option} onClick={(event) => { music.setProjectSettings({ quantize: option }); const details = event.currentTarget.closest('details'); if (details) details.open = false; }}>{option.toUpperCase()}</button>)}</div></details>
              <button type="button" className={metronomeOn ? 'selected' : ''} onClick={() => { void start(); music.setProjectSettings({ metronomeEnabled: !metronomeOn }); }}><b>{metronomeOn ? 'ON' : 'OFF'}</b><small>CLICK</small></button>
              <div className="deck-clear-controls" aria-label="Clear decks">
                <button className="deck-clear" type="button" aria-label="Clear Deck A" title="Clear Deck A" disabled={recording} onClick={clearDeck}><span>CLEAR</span><b>DECK A</b></button>
                <button className="deck-clear" type="button" aria-label="Clear Deck B" title="Clear Deck B" disabled={recording} onClick={clearDeckB}><span>CLEAR</span><b>DECK B</b></button>
              </div>
            </div>
          </div>
          <div className="status-row">
            <div className={`status-screen status-${statusMode}`}><span className="status-copy">{statusCopy}</span><StatusProgress progress={liveSwitchProgress ? 0 : statusProgress} readLiveProgress={liveSwitchProgress ? readTransferProgress : undefined} /><span className="transport-position"><b>BAR {String(currentBar).padStart(2, '0')}</b><b>BEAT {currentBeat}</b></span><span className={`status-dot ${recording ? 'recording' : ''}`} /></div>
            <button className="round-action" type="button" aria-label={transportPlaying ? 'Pause' : 'Play'} onClick={toggleDeck}>{transportPlaying ? 'Ⅱ' : '▶'}</button>
            <div className="record-controls">
              <button className={`round-action record ${recording ? 'armed' : ''}`} type="button" aria-label={recording ? 'Commit recording' : 'Record'} onClick={recording ? commitRecording : beginRecording}><span /></button>
              <button className="record-mode" type="button" title={lastTake} disabled={recording} aria-label={`Recording mode: ${recordMode}`} onPointerDown={toggleRecordMode} onKeyDown={(event) => { if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleRecordMode(); } }}>{recordMode === 'overdub' ? 'OVERDUB' : 'REPLACE'}</button>
            </div>
          </div>
        </section>

        <InstrumentPanel title="Drums" primaryControls={['punch', 'tightness']} {...sharedPanelProps('drums')}>
          <div className="pad-grid">{drumNames.map((name, index) => <button key={name} className={`drum-pad ${pressedShortcuts.has(drumShortcutKeys[index]) && focusedInstrument === 'drums' ? 'shortcut-pressed' : ''}${playingClass('drums', index)}`} onPointerDown={() => triggerDrum(index)}><small>{String(index + 1).padStart(2, '0')} · {drumShortcutKeys[index].toUpperCase()}</small><b>{name}</b></button>)}</div>
        </InstrumentPanel>

        <section className="instrument output" aria-label="Output monitor">
          <OutputSpectrum recorder={music.histogram} started={started} engine={engine} music={music} redraw={redraw} />
        </section>

        <InstrumentPanel title="Bass" primaryControls={['tone', 'shape', 'drive']} {...sharedPanelProps('bass')}>
          <div className="bass-keys">{bassUiKeys.map((note, index) => <button className={`${pressedShortcuts.has(bassShortcutKeys[index]) && focusedInstrument === 'bass' ? 'shortcut-pressed' : ''}${playingClass('bass', note)}`} key={`${note}-${index}`} onPointerDown={(event) => startPointerVoice(event, { kind: 'note', id: `pointer-${event.pointerId}-bass-${note}`, instrument: 'bass', midi: note })} onPointerUp={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onPointerCancel={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onLostPointerCapture={(event) => releasePointerVoice(event.pointerId, event.currentTarget)}><b>{noteName(note)}</b><small>{bassShortcutKeys[index].toUpperCase()}</small></button>)}</div>
        </InstrumentPanel>

        <InstrumentPanel title="Lead" primaryControls={['tone', 'bite', 'echo']} {...sharedPanelProps('lead')}>
          <div className="piano" aria-label="Lead keyboard">{leadKeyboard.white.map(({ midi, shortcut }) => <button className={`${pressedShortcuts.has(shortcut) && focusedInstrument === 'lead' ? 'shortcut-pressed' : ''}${playingClass('lead', midi)}`} key={midi} title={noteName(midi)} onPointerDown={(event) => startPointerVoice(event, { kind: 'note', id: `pointer-${event.pointerId}-lead-${midi}`, instrument: 'lead', midi })} onPointerUp={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onPointerCancel={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onLostPointerCapture={(event) => releasePointerVoice(event.pointerId, event.currentTarget)}><small>{shortcut.toUpperCase()}</small></button>)}{leadKeyboard.black.map(({ midi, shortcut, position }) => <button className={`black-key ${pressedShortcuts.has(shortcut) && focusedInstrument === 'lead' ? 'shortcut-pressed' : ''}${playingClass('lead', midi)}`} style={{ left: `${position}%` }} key={midi} title={noteName(midi)} onPointerDown={(event) => startPointerVoice(event, { kind: 'note', id: `pointer-${event.pointerId}-lead-${midi}`, instrument: 'lead', midi })} onPointerUp={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onPointerCancel={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onLostPointerCapture={(event) => releasePointerVoice(event.pointerId, event.currentTarget)}><small>{shortcut.toUpperCase()}</small></button>)}</div>
        </InstrumentPanel>

        <InstrumentPanel title="Chords" primaryControls={['tone', 'width', 'space']} {...sharedPanelProps('chords')}>
          <div className="chord-pads">{chordPads.map((chord, index) => <button className={`${pressedShortcuts.has(chordShortcutKeys[index]) && focusedInstrument === 'chords' ? 'shortcut-pressed' : ''}${playingClass('chords', chordVisualKey(chord.pitches))}`} key={chord.symbol} onPointerDown={(event) => { event.preventDefault(); const id = `pointer-${event.pointerId}-chord-${index}`; pointerVoices.current.set(event.pointerId, { kind: 'chord', id, root: chord.root }); try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* unavailable */ } void start().then(() => { const at = engine.context?.currentTime; if (at === undefined || pointerVoices.current.get(event.pointerId)?.id !== id) return; engine.holdChord(id, [...chord.pitches]); music.humanChordOn(id, chord.symbol, [...chord.pitches], chord.voicing, 1, at); deckRecorder.recordChordOn(id, chord.symbol, [...chord.pitches], chord.voicing, at); }); }} onPointerUp={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onPointerCancel={(event) => releasePointerVoice(event.pointerId, event.currentTarget)} onLostPointerCapture={(event) => releasePointerVoice(event.pointerId, event.currentTarget)}><b>{chord.roman}</b><small>{chord.symbol} · {chordShortcutKeys[index]}</small></button>)}</div>
        </InstrumentPanel>
      </section>
      <p className="prototype-note">LIVE PROCEDURAL AUDIO · WEBMCP CONNECTED · {started ? 'AUDIO READY' : 'PRESS A CONTROL TO START'}</p>
    </main>
    {showIntro ? <IntroModal scale={uiScale} onClose={() => setShowIntro(false)} /> : null}
  </div>;
}

const polarPoint = (radius: number, angle: number) => {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: 50 + radius * Math.cos(radians), y: 50 + radius * Math.sin(radians) };
};

const ringArc = (radius: number, startTick: number, durationTicks: number) => {
  const startAngle = startTick / DECK_TICKS * 360;
  const sweep = Math.max(3, Math.min(359, durationTicks / DECK_TICKS * 360));
  const start = polarPoint(radius, startAngle);
  const end = polarPoint(radius, startAngle + sweep);
  return `M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
};

function DeckPlatter({ deck, snapshot, activity, playing, resumeToken, countingIn, readPhaseTick, enabled, tempo }: { deck: DeckId; snapshot: DeckSnapshot; activity: number; playing: boolean; resumeToken: number; countingIn: boolean; readPhaseTick: () => number; enabled: Record<DeckInstrument, boolean>; tempo: number }) {
  const rotorRef = useRef<HTMLDivElement>(null);
  const phaseReaderRef = useRef(readPhaseTick);
  const displayTickRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(false);
  const resumeTokenRef = useRef(resumeToken);
  const coastStartedAtRef = useRef<number | null>(null);
  phaseReaderRef.current = readPhaseTick;
  useEffect(() => {
    const rotor = rotorRef.current;
    if (!rotor) return;
    const startedAt = performance.now();
    const transportTick = phaseReaderRef.current();
    const previousTick = displayTickRef.current ?? transportTick;
    const shouldCoast = wasPlayingRef.current && !playing;
    const resumeTokenChanged = resumeTokenRef.current !== resumeToken;
    const resumingFromPause = playing && resumeTokenChanged;
    if (shouldCoast) coastStartedAtRef.current = startedAt;
    const coastElapsed = resumingFromPause ? Math.max(0, startedAt - (coastStartedAtRef.current ?? startedAt)) : 0;
    const resumeOffset = shortestPlatterOffset(previousTick, transportTick);
    wasPlayingRef.current = playing;
    resumeTokenRef.current = resumeToken;
    if (resumingFromPause) coastStartedAtRef.current = null;
    if (resumeTokenChanged && !playing && !shouldCoast) return;
    let frame = 0;
    const draw = (now: number) => {
      const elapsed = now - startedAt;
      let displayTick: number;
      if (playing) {
        const correction = resumingFromPause
          ? platterResumeOffset(resumeOffset, elapsed, coastElapsed, tempo)
          : resumeOffset * Math.pow(1 - Math.max(0, Math.min(1, elapsed / PLATTER_COAST_MS)), 3);
        displayTick = phaseReaderRef.current() + correction;
      } else if (shouldCoast) {
        displayTick = transportTick + platterCoastTicks(elapsed, tempo);
      } else {
        displayTick = transportTick;
      }
      displayTickRef.current = wrapPlatterTick(displayTick);
      rotor.style.transform = `rotate(${platterAngleDegrees(displayTick)}deg)`;
      if (playing || shouldCoast && elapsed < PLATTER_COAST_MS) frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [countingIn, playing, resumeToken, tempo]);
  const lanes: Array<{ instrument: DeckInstrument; radius: number }> = [
    { instrument: 'lead', radius: 39 },
    { instrument: 'drums', radius: 33 },
    { instrument: 'bass', radius: 27 },
    { instrument: 'chords', radius: 20 },
  ];
  return <article className="deck" aria-label={`Deck ${deck}, four bars`}>
    <div className="platter" style={{ '--deck-active': Math.max(0, Math.min(1, activity)) } as CSSProperties}>
      <div ref={rotorRef} className="platter-rotor">
        <span className="radial radial-top" /><span className="radial radial-right" /><span className="radial radial-bottom" /><span className="radial radial-left" />
        <svg className="platter-arcs" viewBox="0 0 100 100" aria-hidden="true">
          {lanes.map(({ instrument, radius }) => <g className={`lane-${instrument} ${enabled[instrument] ? '' : 'lane-off'}`} key={instrument}>
            {snapshot.events[instrument].map((event) => {
              const pathId = `deck-${deck}-${event.id}`;
              return <g key={event.id}><path id={pathId} d={ringArc(radius, event.startTick, 'durationTicks' in event ? event.durationTicks : EIGHTH_NOTE_TICKS / 3)} />{'symbol' in event && <text className="arc-chord"><textPath href={`#${pathId}`} startOffset="3%">{event.symbol}</textPath></text>}</g>;
            })}
          </g>)}
        </svg>
      </div>
    </div>
  </article>;
}

function EnvelopeMini({ instrument, parameters, music }: { instrument: 'bass' | 'chords' | 'lead'; parameters: Record<string, Parameter>; music: MusicController }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<'attack' | 'decay' | 'release' | null>(null);
  const width = 240; const height = 72; const floor = 64;
  const normal = (name: EnvelopeFieldKey) => { const parameter = parameters[name]; return (parameter.value - parameter.min) / Math.max(.0001, parameter.max - parameter.min); };
  const attackX = 10 + normal('attackMs') * 42;
  const decayX = Math.min(130, attackX + 16 + normal('decayMs') * 55);
  const sustainY = 7 + (1 - normal('sustainLevel')) * 48;
  const releaseX = Math.max(decayX + 24, 224 - normal('releaseMs') * 70);
  const points = [{ x: 4, y: floor }, { x: attackX, y: 7 }, { x: decayX, y: sustainY }, { x: releaseX, y: sustainY }, { x: 236, y: floor }];
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const setParameter = (name: EnvelopeFieldKey, ratio: number) => { const parameter = parameters[name]; music.setLiveSound({ instrument, parameters: { [name]: parameter.min + Math.max(0, Math.min(1, ratio)) * (parameter.max - parameter.min) } }); };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * width;
    const y = (event.clientY - rect.top) / rect.height * height;
    if (dragging === 'attack') setParameter('attackMs', (x - 10) / 42);
    if (dragging === 'decay') { setParameter('decayMs', (x - attackX - 16) / 55); setParameter('sustainLevel', 1 - (y - 7) / 48); }
    if (dragging === 'release') { setParameter('releaseMs', (224 - x) / 70); setParameter('sustainLevel', 1 - (y - 7) / 48); }
  };
  const handle = (field: 'attack' | 'decay' | 'release', point: { x: number; y: number }, label: string) => {
    const parameter = parameters[field === 'attack' ? 'attackMs' : field === 'decay' ? 'decayMs' : 'releaseMs'];
    return <circle className="envelope-handle" cx={point.x} cy={point.y} r="4.5" role="slider" aria-label={`${instrument} ${label}`} aria-valuemin={parameter.min} aria-valuemax={parameter.max} aria-valuenow={parameter.value} tabIndex={0} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDragging(field); }} onKeyDown={(event) => {
      const amount = event.shiftKey ? .1 : .025;
      if ((field === 'decay' || field === 'release') && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setParameter('sustainLevel', normal('sustainLevel') + (event.key === 'ArrowUp' ? amount : -amount)); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
      setParameter(field === 'attack' ? 'attackMs' : field === 'decay' ? 'decayMs' : 'releaseMs', normal(field === 'attack' ? 'attackMs' : field === 'decay' ? 'decayMs' : 'releaseMs') + direction * amount);
    }} />;
  };
  return <svg ref={svgRef} className="envelope-mini" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${instrument} controllable envelope`} onPointerMove={move} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
    <path className="envelope-axis" d={`M4 ${floor}H236`} /><path className="envelope-path" d={path} />
    {handle('attack', points[1], 'attack')}{handle('decay', points[2], 'decay and sustain')}{handle('release', points[3], 'release')}<circle className="envelope-end" cx={points[4].x} cy={points[4].y} r="3.2" />
  </svg>;
}

function KnobControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return <label className="control"><span className="knob" style={{ '--turn': `${-135 + safeValue * 270}deg` } as CSSProperties}><input type="range" aria-label={label} min="0" max="1" step=".01" value={safeValue} onChange={(event) => onChange(event.currentTarget.valueAsNumber)} /></span><small>{label.toUpperCase()}</small></label>;
}

const downloadSnapshot = (snapshot: unknown) => {
  const exportedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `synth-debug-${exportedAt.replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

function OutputSpectrum({ recorder, started, engine, music }: { recorder: FrequencyHistogramRecorder; started: boolean; engine: AudioEngine; music: MusicController; redraw: (fn: (n: number) => number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eqRef = useRef<SVGSVGElement>(null);
  const [draggingEq, setDraggingEq] = useState<number | null>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const meterValueRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    let frame = 0;
    const draw = () => {
      if (!alive) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || 180;
      const scale = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.floor(width * scale));
      const pixelHeight = Math.max(1, Math.floor(height * scale));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
      const context = canvas.getContext('2d');
      if (!context) { frame = window.requestAnimationFrame(draw); return; }
      const snapshot = recorder.snapshot(10, true);
      const columns = SPECTRUM_COLUMNS;
      const rows = SPECTRUM_ROWS;
      const history = snapshot.samples;
      const latest = history.at(-1)?.intensities;
      const peak = latest?.length ? Math.max(...latest) : 0;
      if (meterRef.current) meterRef.current.style.height = `${Math.max(3, Math.min(100, peak * 100))}%`;
      if (meterValueRef.current) meterValueRef.current.textContent = peak > 0 ? `${Math.max(-60, 20 * Math.log10(peak)).toFixed(1)} dB` : '−∞ dB';
      const palette = Array.from({ length: 64 }, (_, index) => {
        const intensity = index / 63;
        if (intensity < .08) return [17, 17, 15];
        const amount = (intensity - .08) / .92;
        const stops = [[22, 35, 76], [72, 45, 149], [211, 77, 61], [230, 235, 105]];
        const position = amount * (stops.length - 1);
        const lower = Math.floor(position);
        const upper = Math.min(stops.length - 1, lower + 1);
        const mix = position - lower;
        return stops[lower].map((value, channel) => Math.round(value + (stops[upper][channel] - value) * mix));
      });
      const heatmap = document.createElement('canvas');
      heatmap.width = columns;
      heatmap.height = rows;
      const heatmapContext = heatmap.getContext('2d');
      const image = heatmapContext?.createImageData(columns, rows);
      if (heatmapContext && image) {
        const firstVisibleColumn = columns - history.length;
        for (let x = 0; x < columns; x++) {
          const sample = x < firstVisibleColumn ? undefined : history[x - firstVisibleColumn];
          for (let row = 0; row < rows; row++) {
            const intensity = sample?.intensities?.[row] ?? 0;
            const color = palette[Math.min(63, Math.round(intensity * 63))];
            const pixel = ((rows - 1 - row) * columns + x) * 4;
            image.data[pixel] = color[0]; image.data[pixel + 1] = color[1]; image.data[pixel + 2] = color[2]; image.data[pixel + 3] = 255;
          }
        }
        heatmapContext.putImageData(image, 0, 0);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, width, height);
        context.imageSmoothingEnabled = false;
        context.drawImage(heatmap, 0, 0, width, height);
        const sampleRate = recorder.snapshot(10).frequencyRangeHz[1] * 2;
        const maxFrequency = Math.min(SPECTRUM_MAX_FREQUENCY, sampleRate / 2);
        const logMin = Math.log(SPECTRUM_MIN_FREQUENCY);
        const logMax = Math.log(maxFrequency);
        context.strokeStyle = 'rgba(243, 240, 233, .16)';
        context.lineWidth = 1;
        context.beginPath();
        for (const frequency of [20, 100, 1000, 10000, 20000]) {
          if (frequency > maxFrequency) continue;
          const y = height - ((Math.log(frequency) - logMin) / (logMax - logMin)) * height;
          context.moveTo(0, Math.round(y) + .5); context.lineTo(width, Math.round(y) + .5);
        }
        context.moveTo(width / 2 + .5, 0); context.lineTo(width / 2 + .5, height); context.stroke();
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => { alive = false; window.cancelAnimationFrame(frame); };
  }, [recorder, started]);

  const output = engine.outputControls;
  const setOutput = (name: keyof typeof output, value: number) => { music.setOutput({ [name]: value }); };
  const eqPoints = [output.eqLowDb, output.eqMidDb, output.eqHighDb].map((gain, index) => ({ x: 18 + index * 102, y: 38 - gain / 12 * 25 }));
  const eqPath = `M 0 ${eqPoints[0].y} Q ${eqPoints[0].x} ${eqPoints[0].y} ${eqPoints[1].x} ${eqPoints[1].y} T 240 ${eqPoints[2].y}`;
  const eqNames = ['eqLowDb', 'eqMidDb', 'eqHighDb'] as const;
  const moveEq = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (draggingEq === null || !eqRef.current) return;
    const rect = eqRef.current.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height * 76;
    setOutput(eqNames[draggingEq], Math.max(-12, Math.min(12, (38 - y) / 25 * 12)));
  };
  return <div className="output-body">
    <div className={`heatmap ${started ? '' : 'sleeping'}`}><span className="spectrum-title">SPECTRUM</span><canvas ref={canvasRef} className="spectrum-canvas" aria-label="Scrolling output frequency spectrum" /><div className="heatmap-labels"><span>20k</span><span>1k</span><span>20</span></div><div className="heatmap-time"><span>PAST</span><span>NOW</span></div></div>
    <section className="output-eq" aria-label="Three-band output equalizer"><span className="module-label">EQ · DRAG POINTS</span><svg ref={eqRef} viewBox="0 0 240 76" role="group" aria-label="Three-band output equalizer controls" onPointerMove={moveEq} onPointerUp={() => setDraggingEq(null)} onPointerCancel={() => setDraggingEq(null)}><path className="eq-grid" d="M0 13H240M0 38H240M0 63H240M18 5V70M120 5V70M222 5V70" /><path className="eq-curve" d={eqPath} />{eqPoints.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="5" role="slider" tabIndex={0} aria-label={`${['Low', 'Mid', 'High'][index]} EQ`} aria-valuemin={-12} aria-valuemax={12} aria-valuenow={output[eqNames[index]]} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setDraggingEq(index); }} onKeyDown={(event) => { if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return; event.preventDefault(); setOutput(eqNames[index], output[eqNames[index]] + (event.key === 'ArrowUp' ? .5 : -.5)); }} />)}<text x="18" y="75">LOW</text><text x="120" y="75">MID</text><text x="222" y="75">HIGH</text></svg></section>
    <section className="echo-module" aria-label="Output echo"><span className="module-label">ECHO</span><div className="echo-controls"><KnobControl label="time" value={(output.echoTimeMs - 40) / 860} onChange={(value) => setOutput('echoTimeMs', 40 + value * 860)} /><KnobControl label="feedback" value={output.echoFeedback / .75} onChange={(value) => setOutput('echoFeedback', value * .75)} /><KnobControl label="mix" value={output.echoMix} onChange={(value) => setOutput('echoMix', value)} /></div></section>
    <div className="master-module"><span className="module-label">MASTER</span><div className="master-meter" style={{ '--master': output.masterVolume } as CSSProperties}><span ref={meterRef} /><i /><input aria-label="Master volume" type="range" min="0" max="1" step=".01" value={output.masterVolume} onChange={(event) => setOutput('masterVolume', event.currentTarget.valueAsNumber)} /></div><em ref={meterValueRef}>−∞ dB</em></div>
  </div>;
}

function EnvelopeEditor({ instrument, parameters, music }: { instrument: 'bass' | 'chords' | 'lead'; parameters: Record<string, Parameter>; music: MusicController }) {
  const values: EnvelopePreviewValues = {
    attackMs: parameters.attackMs.value,
    decayMs: parameters.decayMs.value,
    sustainLevel: parameters.sustainLevel.value,
    releaseMs: parameters.releaseMs.value,
  };
  const geometry = envelopePreviewGeometry(values);
  const update = (key: EnvelopeFieldKey, displayValue: number) => {
    music.setLiveSound({ instrument, parameters: { [key]: envelopeParameterValue(key, displayValue) } });
  };
  return <section className="envelope-editor" aria-labelledby={`envelope-${instrument}`}>
    <div className="envelope-head">
      <h3 id={`envelope-${instrument}`}>Envelope</h3>
      <svg className="envelope-preview" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="img" aria-label={`${instrument} ADSR envelope preview`}>
        <title>{`${instrument} attack, decay, sustain, release envelope`}</title>
        <path d={envelopePath(geometry)} />
        {geometry.regions.map((region) => <text key={region.label} x={region.x + region.width / 2} y={geometry.height - 7}>{region.label}</text>)}
      </svg>
    </div>
    <div className="envelope-controls">
      {ENVELOPE_FIELDS.map((field) => {
        const parameter = parameters[field.key];
        const bounds = envelopeDisplayBounds(field.key, parameter);
        const displayValue = envelopeDisplayValue(field.key, parameter.value);
        return <label className="envelope-field" key={field.key}>
          <span>{field.label}<small>{field.unit}</small></span>
          <input type="range" aria-label={`${field.label} ${instrument} envelope`} min={bounds.min} max={bounds.max} step={bounds.step} value={displayValue} onChange={(event) => update(field.key, event.currentTarget.valueAsNumber)} />
          <input className="number-input" type="number" aria-label={`${field.label} ${instrument} envelope value`} min={bounds.min} max={bounds.max} step={bounds.step} value={displayValue} onChange={(event) => update(field.key, event.currentTarget.valueAsNumber)} />
          <span className="envelope-unit">{field.unit}</span>
        </label>;
      })}
    </div>
  </section>;
}

function InstrumentPanel({ title, instrument, focused = false, onFocus, presets, selected, setPreset, engine, music, children, primaryControls, enabled, pendingToggle, onToggle, locked }: { title: string; instrument: DeckInstrument; focused?: boolean; onFocus?: () => void; presets: readonly string[]; selected: number; setPreset: (value: number) => void; engine: AudioEngine; music: MusicController; redraw: (fn: (n: number) => number) => void; children: ReactNode; primaryControls: string[]; enabled: boolean; pendingToggle: { cueId: string; enabled: boolean; at: { cycle: number; bar: number; tick: number }; ticksUntil: number } | null; onToggle: () => void; locked: boolean }) {
  const parameters = engine.parameters[instrument];
  const hasEnvelope = instrument === 'bass' || instrument === 'chords' || instrument === 'lead';
  const setControl = (name: string, value: number) => { music.setLiveSound({ instrument, controls: { [name]: value } }); };
  return <section className={`instrument ${instrument} ${focused ? 'is-focused' : 'is-muted'} ${locked ? 'recording-locked' : ''}`} aria-disabled={locked} onPointerDownCapture={(event) => { if (locked) { event.preventDefault(); event.stopPropagation(); } }} onPointerDown={() => { if (!locked) onFocus?.(); }}>
    <header className="instrument-header">
      <details className="instrument-preset boxed"><summary aria-label={`${title} preset`}><span>{title.toUpperCase()}:</span><b>{presets[selected].toUpperCase()}</b><i>⌄</i></summary><div className="preset-menu">{presets.map((preset, index) => <button type="button" className={selected === index ? 'selected' : ''} key={preset} onClick={(event) => { setPreset(index); const details = event.currentTarget.closest('details'); if (details) details.open = false; }}>{preset.toUpperCase()}</button>)}</div></details>
      {hasEnvelope ? <EnvelopeMini instrument={instrument} parameters={parameters} music={music} /> : null}
      <div className="compact-controls">{primaryControls.map((name) => <KnobControl key={name} label={name} value={engine.controls[instrument][name] ?? 0} onChange={(value) => setControl(name, value)} />)}<KnobControl label="volume" value={engine.volumes[instrument]} onChange={(value) => { music.setLiveSound({ instrument, volume: value }); }} /><button className={`power ${enabled ? 'on' : ''}`} type="button" aria-label={`${enabled ? 'Disable' : 'Enable'} ${title}`} aria-pressed={enabled} onClick={(event) => { event.stopPropagation(); onToggle(); }}>{pendingToggle && <small>{Math.max(1, Math.ceil(pendingToggle.ticksUntil / (EIGHTH_NOTE_TICKS * 8)))}</small>}</button></div>
    </header>
    {children}
  </section>;
}

function ParameterControl({ instrument, presetIndex, name, parameter, music }: { instrument: Instrument; presetIndex: number; name: string; parameter: Parameter; music: MusicController }) {
  return <label className="parameter"><span>{parameter.label}<small>{parameter.unit || 'value'}</small></span><input type="range" min={parameter.min} max={parameter.max} step={parameter.step} value={parameter.value} onChange={(e) => { music.setLiveSound({ instrument, parameters: { [name]: Number(e.target.value) } }); }} /><input className="number-input" type="number" min={parameter.min} max={parameter.max} step={parameter.step} value={parameter.value} onChange={(e) => { music.setLiveSound({ instrument, parameters: { [name]: Number(e.target.value) } }); }} /><button type="button" className="reset" title={`Reset ${parameter.label} to preset default`} aria-label={`Reset ${parameter.label}`} onClick={() => { music.resetLiveParameter(instrument, presetIndex, name); }}>↺</button></label>;
}

createRoot(document.getElementById('root')!).render(<App />);
