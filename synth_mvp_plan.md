# Synth MVP Plan

## 1. Goal

Build the first complete audio layer for the project: four playable browser instruments for drums, bass, chords, and lead, with no imported or prerecorded samples.

The MVP must prove that:

- All four instruments can play together without audible timing drift.
- Every sound comes from oscillators, filters, envelopes, procedural noise, and generated effects.
- Each instrument has one visible set of live controls.
- Recording copies the current live sound into a Deck Sound Profile.
- Later deck playback can reproduce the recorded sound without depending on the current live controls.
- The engine accepts exact musical times so human recordings and agent cues can use the same scheduler.

This is an audio-engine milestone. It does not include the finished turntable interface, WebMCP tools, agent prompting, or a full production workflow.

## 2. Product constraints

### Required

- Browser-native audio through the Web Audio API.
- TypeScript for all engine and state code.
- No audio sample assets in the repository.
- No sample packs, recorded drum hits, or sampled instruments.
- All saved sound settings must be plain serializable data.
- Human input must feel immediate.
- Scheduled playback must use audio-clock time rather than animation frames or `setTimeout` alone.
- The four instruments must share a master output and remain independently controllable.

### Deliberately excluded

- Modular patch cables or user-defined routing.
- Arbitrary oscillator construction.
- Imported samples.
- Audio recording.
- Per-note synth patches.
- Recorded knob automation.
- Mastering tools.
- A large preset browser.
- A full mixer.
- Third-party plug-ins.
- Final mobile layout.

## 3. Technical approach

Use the native Web Audio API rather than a large synthesis framework. The synthesis required for the MVP is small enough to implement directly, and direct Web Audio nodes give us precise scheduling and serializable settings without adding another timing model.

Use a React and TypeScript application for the eventual interface, but keep the audio engine independent of React. React components may call engine methods; the engine must never rely on component renders for timing.

### Audio graph

```text
DrumSynth  ──┐
BassSynth  ──┤
ChordSynth ──┼── Instrument gains ── Master compressor ── Output
LeadSynth  ──┤
Effects     ─┘
```

Each instrument owns:

- Its active voices.
- Its live sound profile.
- An output gain node.
- A dry path.
- A delay send.
- A generated-reverb send.

The master owns:

- The shared delay return.
- The shared generated-reverb return.
- A gentle `DynamicsCompressorNode` used as a safety limiter.
- The final connection to `AudioContext.destination`.

### Audio startup

Browsers require a human gesture before audio can begin. The first press on the page will call `audioContext.resume()` and initialise the engine. The interface must show a clear start control until the context is running.

Do not recreate the `AudioContext` when the interface changes. Create one context for the session and suspend it only when the page becomes inactive or the user explicitly stops audio.

## 4. Core engine modules

The engine should be split into small modules with no UI imports:

```text
src/audio/
├── AudioEngine.ts
├── Transport.ts
├── Scheduler.ts
├── profiles.ts
├── effects/
│   ├── GeneratedReverb.ts
│   ├── FeedbackDelay.ts
│   └── Saturator.ts
└── instruments/
    ├── InstrumentSynth.ts
    ├── DrumSynth.ts
    ├── BassSynth.ts
    ├── ChordSynth.ts
    ├── LeadSynth.ts
    └── voices/
        ├── SubtractiveVoice.ts
        ├── FMVoice.ts
        └── NoiseSource.ts
```

The exact folder names may change during implementation, but the boundaries should remain.

### Common instrument contract

```ts
type Instrument = "drums" | "bass" | "chords" | "lead";

interface InstrumentSynth<P> {
  setLiveProfile(profile: P): void;
  getLiveProfile(): P;
  noteOn(pitch: number, velocity: number, at: number): string;
  noteOff(voiceId: string, at: number): void;
  stopAll(at: number): void;
  dispose(): void;
}
```

Drums will also expose a one-shot trigger method because drum hits do not need conventional note-off handling.

All `at` values are `AudioContext.currentTime` seconds. Musical bar-and-tick positions are converted to audio seconds by the scheduler before reaching an instrument.

## 5. Musical clock and scheduler

Use these constants initially:

```ts
const PPQ = 480;
const BEATS_PER_BAR = 4;
const BARS_PER_CYCLE = 24;
const EIGHTH_NOTE_TICKS = PPQ / 2; // 240
```

The global clock uses:

```ts
type MusicalTime = {
  cycle: number;
  bar: number;  // 0-23 internally
  tick: number; // 0-1919 in a 4/4 bar
};
```

Convert it to an absolute tick with:

```ts
absoluteBar = cycle * BARS_PER_CYCLE + bar;
absoluteTick = absoluteBar * BEATS_PER_BAR * PPQ + tick;
```

The scheduler will:

1. Wake every 25 ms.
2. Look roughly 100 ms ahead.
3. Convert upcoming absolute ticks into `AudioContext` seconds.
4. Schedule oscillator starts, stops, and parameter curves on the audio clock.
5. Never use React renders as the source of playback timing.

This look-ahead scheduler is enough for the MVP. An `AudioWorklet` scheduler can replace it later if profiling shows that main-thread stalls cause missed events.

## 6. Recording and quantisation

The MVP always quantises recorded note starts and endings to eighth notes.

```ts
function quantizeToEighth(tick: number): number {
  return Math.round(tick / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
}
```

Rules:

- Snap note start and note end independently.
- Enforce a minimum duration of 240 ticks.
- Drum hits only need a quantised start.
- Chords use a quantised start and duration.
- Notes recorded past the end of a deck wrap into its local loop.
- Quantisation strength is always 100% in the MVP.
- Swing may later alter playback timing without rewriting stored note positions.

Recording uses a temporary take:

```text
Arm deck and instrument
        ↓
Play the live instrument
        ↓
Store raw note-on and note-off ticks in a temporary take
        ↓
Stop recording
        ↓
Quantise to eighth notes
        ↓
Overdub or explicitly replace the selected range
        ↓
Copy current live controls into that deck's Deck Sound Profile
        ↓
Commit notes and profile as one undoable action
```

Cancelling a take changes neither notes nor the Deck Sound Profile.

## 7. Sound-profile model

There is one live profile per instrument. Each deck also stores one captured Deck Sound Profile per instrument.

```text
Live instrument controls
        ├── heard immediately when the human plays
        ├── copied to Deck A after a successful recording to A
        └── copied to Deck B after a successful recording to B
```

Changing live controls after recording does not change either deck.

Use normalised values from 0 to 1 so the UI, saved projects, presets, and agent tools use the same range.

```ts
type BaseDeckSoundProfile = {
  presetId: string;
  volume: number;
};

type DrumSoundProfile = BaseDeckSoundProfile & {
  instrument: "drums";
  controls: {
    punch: number;
    tightness: number;
    dirt: number;
    room: number;
  };
};

type BassSoundProfile = BaseDeckSoundProfile & {
  instrument: "bass";
  controls: {
    tone: number;
    shape: number;
    glide: number;
    drive: number;
  };
};

type ChordSoundProfile = BaseDeckSoundProfile & {
  instrument: "chords";
  controls: {
    tone: number;
    attack: number;
    width: number;
    space: number;
  };
};

type LeadSoundProfile = BaseDeckSoundProfile & {
  instrument: "lead";
  controls: {
    tone: number;
    bite: number;
    motion: number;
    echo: number;
  };
};

type DeckSoundProfile =
  | DrumSoundProfile
  | BassSoundProfile
  | ChordSoundProfile
  | LeadSoundProfile;
```

The live profiles may use the same TypeScript types. “Deck Sound Profile” refers to the captured copy stored by a deck.

## 8. Drum synth

The drum instrument uses eight fully synthesised voices. No drum hit is loaded from a file.

### Pad set

1. Kick
2. Snare
3. Closed hi-hat
4. Open hi-hat
5. Clap
6. Low tom
7. High tom
8. Percussion

The final interface may show a larger grid, but eight unique generators are enough for the first audio milestone.

### Kick

- Sine oscillator.
- Pitch envelope from roughly 150 Hz to 45-60 Hz over 60-100 ms.
- Fast attack and exponential amplitude decay around 250-500 ms.
- Optional short high-frequency click made from procedural noise.
- `punch` raises initial pitch and click level.
- `tightness` shortens the amplitude decay.
- `dirt` adds waveshaping.
- `room` controls reverb send.

### Snare

- Triangle or sine body around 160-220 Hz.
- Procedural white noise through a band-pass and high-pass filter.
- Noise decay around 120-250 ms.
- Tone body decays slightly faster than the noise.
- `punch` changes body level.
- `tightness` changes both decays.
- `dirt` changes saturation and noise colour.
- `room` controls reverb send.

### Hi-hats

- Six square oscillators at inharmonic frequency ratios, mixed quietly.
- High-pass filter around 6-8 kHz.
- Closed-hat decay around 30-80 ms.
- Open-hat decay around 250-600 ms.
- Triggering the closed hat should choke the open-hat voice.

### Clap

- Procedural band-passed noise.
- Three short bursts separated by roughly 15-25 ms.
- A final longer noise tail.

### Toms and percussion

- Sine or triangle oscillator with a short downward pitch envelope.
- Low and high tom differ primarily in base pitch.
- Percussion uses a more metallic inharmonic oscillator pair.

### Procedural noise

Generate a short white-noise `AudioBuffer` at engine startup using random values. This is procedural source material, not an imported sample. Reuse the generated buffer for noise-based voices to avoid allocating a large buffer on every hit.

### Drum presets

Start with six profiles:

- Clean
- Classic
- Soft
- Tight
- Industrial
- Lo-fi

Presets change synthesis parameters behind the four visible controls. They do not load audio files.

## 9. Bass synth

The bass is monophonic and supports legato playing.

### Signal path

```text
Main oscillator ─┐
Sub oscillator  ─┼── Mixer ── Low-pass filter ── Saturator ── Amp envelope
Transient click ─┘
```

### Voice behaviour

- Main oscillator supports sine, triangle, saw, and square shapes.
- Sub oscillator sits one octave below and uses sine or square.
- Four-pole-style low-pass response approximated with one or two `BiquadFilterNode`s.
- Separate amplitude and filter envelopes.
- Glide applies only between overlapping notes.
- Repeated notes reuse the monophonic voice where possible.
- A new non-legato note retriggers both envelopes.

### Controls

- `tone`: filter cutoff and a small amount of filter-envelope depth.
- `shape`: oscillator blend and pulse/saw character.
- `glide`: portamento time from 0 to roughly 250 ms.
- `drive`: waveshaper input and output compensation.

### Presets

- Sub
- Rubber
- Acid
- Pluck
- Pulse
- Distorted

## 10. Chord synth

The chord instrument is polyphonic with a maximum of eight active voices. Each chord event stores its label and exact pitches, so synthesis never has to guess a voicing.

### Chord event

```ts
type ChordEvent = {
  id: string;
  startTick: number;
  durationTicks: number;
  symbol: string;
  pitches: number[];
  voicing?: "root" | "open" | "first-inversion" | "second-inversion";
};
```

### Voice modes

Use one shared polyphonic wrapper with three procedural voice modes:

- Subtractive: detuned saw, triangle, or pulse oscillators through a filter.
- FM: a carrier oscillator with a sine modulator connected to its frequency.
- Organ: several sine oscillators at harmonic ratios with no filter envelope.

This supports a useful range without a modular engine.

### Controls

- `tone`: filter cutoff or FM brightness.
- `attack`: amplitude and filter attack.
- `width`: oscillator detune, stereo placement, and chorus depth.
- `space`: delay and generated-reverb sends.

### Presets

- Warm Pad
- Soft Keys
- Glass FM
- Organ
- Pluck
- Wide Saw

Do not promise acoustic-piano realism without samples. The presets should sound intentional and electronic.

## 11. Lead synth

The lead is playable from the on-screen keyboard, computer keyboard, and later Web MIDI. It supports up to four voices, while monophonic presets may restrict it to one.

### Signal path

```text
Oscillator A ─┐
Oscillator B ─┼── Mixer ── Filter ── Saturator ── Amp ── Delay/reverb sends
FM modulator ─┘
```

### Features

- Sine, triangle, saw, square, and pulse sources.
- Optional two-operator FM.
- Amplitude and filter envelopes.
- Vibrato LFO.
- Small detune range.
- Optional mono legato and glide.
- Delay synced to the transport.

### Controls

- `tone`: filter cutoff or FM brightness.
- `bite`: envelope snap, resonance, and drive.
- `motion`: vibrato or slow timbral movement.
- `echo`: delay send and feedback within a safe range.

### Presets

- Bright Mono
- Soft Sine
- Pulse Lead
- FM Bell
- Distorted
- Airy

## 12. Generated effects

No impulse-response or effect sample files should be used.

### Delay

- One shared `DelayNode`.
- Delay time derived from the transport tempo.
- Feedback kept below a safe maximum.
- A filter in the feedback path prevents harsh accumulation.

### Reverb

Generate a short stereo decaying-noise impulse at startup and load it into a `ConvolverNode`. The impulse is generated locally and is never saved as an audio asset.

If the generated convolution tail proves too expensive, replace it with a small network of feedback delays. Do not introduce a downloaded impulse response.

### Saturation

Use a `WaveShaperNode` with a generated soft-clipping curve. Apply output compensation so raising `drive` does not only make the instrument louder.

## 13. Voice management

Every voice must disconnect its nodes after release to prevent memory and CPU growth.

Rules:

- Bass: one active voice.
- Chords: maximum eight voices.
- Lead: maximum four voices.
- Drums: allow overlapping one-shots, but cap each drum family.
- Closed hat chokes open hat.
- When the voice limit is reached, steal the oldest released voice first, then the oldest active voice.
- `stopAll()` must release or stop every active voice without clicks.
- Switching presets changes future voices, not voices already releasing.

## 14. Minimal development interface

Before building the final interface, create a plain test surface containing:

- Audio start button.
- Tempo input.
- Eight drum pads.
- Eight bass keys.
- Four chord buttons.
- A two-octave lead keyboard.
- Preset selector for each instrument.
- Four controls and volume for each instrument.
- Start/stop transport.
- A simple test pattern button.
- Panic button that calls `stopAll()` on every instrument.

The test surface exists to validate sound, scheduling, and control mapping. It should not define the final visual design.

## 15. Implementation sequence

### Milestone 1: Engine shell

- Create the application scaffold.
- Initialise one `AudioContext` after a human gesture.
- Build master gain, compressor, delay, and generated reverb.
- Add the common instrument contract.
- Add a panic function.

Acceptance:

- Audio starts reliably after one click.
- The engine can start, stop, and dispose without console errors.
- Master output does not clip under a basic four-instrument test.

### Milestone 2: Procedural drums

- Implement all eight drum generators.
- Add hat choking.
- Map the four drum controls.
- Add six presets.

Acceptance:

- Every pad produces a distinct useful sound.
- Rapid repeated hits do not leak nodes or cause stuck sound.
- No audio file exists in the project.

### Milestone 3: Bass

- Implement the monophonic voice.
- Add filter envelope, glide, and drive.
- Add six presets.

Acceptance:

- Legato and retrigger behaviour are distinct and predictable.
- Bass remains audible on small speakers without excessive master level.

### Milestone 4: Chords

- Implement subtractive, FM, and organ voice modes.
- Add eight-voice polyphony and voice stealing.
- Add six presets and four controls.
- Render semantic chord events from exact stored pitches.

Acceptance:

- Four-note chords can change cleanly without stuck voices.
- Each preset remains recognisably different under the same progression.

### Milestone 5: Lead

- Implement mono and four-voice modes.
- Add vibrato, delay, and optional FM.
- Map computer keys to a two-octave range.
- Add six presets.

Acceptance:

- Live keyboard input feels immediate.
- Fast notes and held notes release correctly.
- Delay remains synchronised after a tempo change.

### Milestone 6: Profiles and scheduling

- Implement live profiles and captured Deck Sound Profiles.
- Implement bar, cycle, and tick conversion.
- Add the look-ahead scheduler.
- Add eighth-note recording quantisation.
- Render a test pattern with all four instruments.

Acceptance:

- Changing a live profile after capture does not alter the captured deck sound.
- A scheduled four-bar pattern loops without accumulating audible drift.
- Recorded events land on the eighth-note grid.

### Milestone 7: Verification and cleanup

- Add automated and manual tests.
- Profile node counts and CPU use.
- Review preset volumes.
- Remove unused parameters and experimental UI.
- Document the final audio API for the deck and cue work.

## 16. Testing plan

### Automated tests

Use `OfflineAudioContext` where possible:

- Each preset renders non-silent output.
- Each instrument stops producing meaningful output after its release tail.
- Quantisation maps ticks to multiples of 240.
- Four bars contain 7680 ticks.
- Cycle/bar/tick conversion remains monotonic across the 24-bar boundary.
- Deck Sound Profiles serialize and restore without changing values.
- Voice stealing never exceeds the configured limit.

### Manual browser tests

- Start audio after a fresh page load.
- Play all instruments at once.
- Hold lead notes while triggering drums rapidly.
- Change each live control across its full range.
- Change tempo during a scheduled pattern.
- Switch presets while notes release.
- Run the test pattern for at least five minutes.
- Use the panic button during dense playback.
- Confirm there are no stuck voices or growing node counts.

### Sound review

For every preset, check:

- It is musically useful at its default settings.
- Its four controls create clear changes.
- No control produces silence except at an intentional edge.
- No control causes dangerous feedback or sudden extreme volume.
- The preset sits reasonably beside the other three instruments.

## 17. Definition of done

The synth MVP is complete when:

- Drums, bass, chords, and lead all work in the browser.
- No imported audio sample is used.
- Each instrument has at least six presets and four useful controls.
- The four instruments can play together through one master output.
- Live playing and scheduled playing both work.
- Recorded timing always quantises to eighth notes.
- Recording captures a Deck Sound Profile without linking it to later live changes.
- Chords retain both their display labels and exact pitches.
- Playback remains stable over a five-minute test.
- The audio engine exposes a documented interface for the later deck, solo, and cue systems.

