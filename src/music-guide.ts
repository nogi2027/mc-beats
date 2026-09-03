import { BAR_TICKS, CYCLE_BARS, SOLO_OPENING_TICKS } from './music-controller.ts';
import { DECK_TICKS, EIGHTH_NOTE_TICKS, PPQ } from './deck.ts';
import { MUSIC_PRESETS } from './music-catalog.ts';

export const DRUM_PAD_MAP = ['Kick', 'Snare', 'Closed Hat', 'Open Hat', 'Clap', 'Low Tom', 'High Tom', 'Perc', 'Rim', 'Shaker', 'Cowbell', 'Ride'];

const sections = {
  overview: {
    rule: 'The UI is optional. Start with music_get_agent_brief. Prefer the high-level recipe tools, which resolve scale degrees, pitches, ticks, chord names, and complete sound profiles. Use music_get_state and low-level cue tools only when precise manual control is needed.',
    setupWorkflow: ['Call music_get_agent_brief for current context and ready-to-use actions.', 'Call music_initialize_audio. If the browser reports that a user gesture is required, ask for that one audio permission and retry.', 'Call music_set_project_settings for BPM, key, quantization, metronome, and switch effect.', 'Use music_fill_inactive_deck, music_start_guided_solo, or music_schedule_section before assembling low-level calls.', 'Use music_get_live_feed to follow human playing without giving the agent live performance or recording controls.'],
    time: { ppq: PPQ, eighthNoteTicks: EIGHTH_NOTE_TICKS, barTicks: BAR_TICKS, deckLoopTicks: DECK_TICKS, deckLoopBars: 4, cycleBars: CYCLE_BARS },
  },
  timing: {
    boundaries: {
      'next-safe': 'Earliest eighth-note boundary outside the audio lookahead window.',
      'next-eighth': 'Next eighth-note boundary.',
      'next-beat': 'Next quarter-note beat.',
      'next-bar': 'Next bar downbeat. This is the normal solo start and the latest a newly requested solo should wait.',
      'next-four-bar-boundary': 'Next deck-loop boundary.',
    },
    soloRule: 'Prefer next-bar for a clean solo entrance. Use next-safe or next-beat only when an earlier entrance is useful. Never defer a ready solo past the next bar.',
    realtimeRule: 'The musical clock keeps moving while you think, narrate, read state, and make tool calls. Prepare the opening before starting a solo. During a timed sequence, call the next tool at once and do not add commentary or reread state between calls.',
  },
  deckBuilding: {
    workflow: ['Call music_fill_inactive_deck with 1-4 scale degrees and optional drum, bass, chord, and preset choices.', 'Use music_build_progression only when a specific deck must be named.', 'Cue a transfer after the generated deck is ready.', 'Use music_prepare_deck only for exact event-level work.'],
    note: 'The recipe tools repeat a short progression to four bars and create deterministic accompaniment. Optional drumHits use names such as kick, snare, and closed-hat instead of pad numbers. They do not change the audible active deck.',
  },
  soloStreaming: {
    workflow: ['For the quickest start, call music_start_guided_solo with notes from bars 1 and 2 only.', 'The guided tool accepts later bars and stages them automatically, but larger calls take longer to process.', 'Use music_schedule_section when the full solo and optional deck handoff are already known.', 'For open-ended work, add later phrases with music_stage_solo_events from offsetTicks 3840 (bar 3) onward.', 'Do not narrate, reread state, or reason between time-sensitive calls.'],
    note: 'Both opening bars must contain a note so playback can begin safely. Extra bars no longer cause failure; they use the slower staging path. Low-level relative offsets remain available for exact edits.',
  },
  examples: {
    project: { tempo: 120, keyRoot: 0, keyMode: 'minor', quantize: '1/8', metronomeEnabled: true, switchEffect: 'blend' },
    liveSound: { instrument: 'bass', presetId: 'Sub', controls: { tone: .45 }, volume: .8 },
    output: { masterVolume: .8, eqLowDb: 1.5, echoMix: .15 },
    prepareDeck: { deck: 'B', tracks: [{ instrument: 'drums', mode: 'replace', events: [{ type: 'drum', id: 'b-kick-1', startTick: 0, pad: 0, velocity: .9 }] }] },
    fillInactiveDeck: { progression: [1, 4, 1, 5], drums: 'backbeat', bass: 'roots', chords: 'sustained', sounds: { bass: { presetId: 'Sub' }, chords: { presetId: 'Warm Pad' } } },
    guidedSolo: { soloId: 'lead-1', instrument: 'lead', lengthBars: 4, when: 'next-bar', sound: { presetId: 'Bright Mono' }, openingNotes: [{ bar: 1, degree: 1, duration: '1/4' }, { bar: 2, degree: 3, duration: '1/4' }] },
    scheduledSection: { soloId: 'lead-16', instrument: 'lead', lengthBars: 16, when: 'next-bar', notes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 9, degree: 5 }], transfer: { destination: 'B', afterBars: 8, style: 'blend', durationBeats: 1 } },
    cueSolo: { when: 'next-bar', soloId: 'lead-1', instrument: 'lead', description: 'Short answer phrase', lengthBars: 4, soundProfile: '<complete lead profile from state>', initialEvents: [{ type: 'note', id: 'lead-1-a', offsetTicks: 0, instrument: 'lead', durationTicks: 240, pitch: 74, velocity: .8 }, { type: 'note', id: 'lead-1-b', offsetTicks: BAR_TICKS, instrument: 'lead', durationTicks: 240, pitch: 77, velocity: .8 }] },
    stageSolo: { soloId: 'lead-1', events: [{ type: 'note', id: 'lead-1-c', offsetTicks: SOLO_OPENING_TICKS, instrument: 'lead', durationTicks: 240, pitch: 79, velocity: .8 }] },
  },
  catalog: { drumPads: DRUM_PAD_MAP.map((name, pad) => ({ pad, name })), presets: MUSIC_PRESETS },
} as const;

export type MusicGuideTopic = keyof typeof sections | 'all';

export const musicUsageGuide = (topic: MusicGuideTopic = 'all', tempo = 120) => ({
  protocolVersion: 3,
  topic,
  realtimeBudget: {
    tempo,
    secondsPerBar: Number((240 / tempo).toFixed(2)),
    estimatedTokensPerBarAt30Tps: Math.round(7200 / tempo),
    formula: 'tokensPerBar = 7200 / BPM for 4/4 music at 30 tokens per second',
    warning: 'Respond almost immediately during live scheduling. At 120 BPM there are about 60 generated tokens per bar, not 240. Prepare data before the first timed call.',
  },
  ...(topic === 'all' ? sections : { [topic]: sections[topic] }),
});
