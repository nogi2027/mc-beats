# Interaction Design

## 1. Core concept

The application is one fixed musical instrument centred on two turntables. It is not a conventional DAW and does not expose a long arrangement timeline.

The fixed surface always shows:

- Deck A and Deck B.
- Drum controls.
- Bass controls.
- Chord controls.
- A lead keyboard.
- The transfer control between the decks.
- A minimal solo status strip.

The human can play and change every instrument directly. The agent never performs unscheduled interface gestures. It only creates musical cues, which the browser executes on the shared musical clock.

## 2. Interface layout

The intended large-screen layout is:

```text
┌────────────────────────────────────────┬─────────────┐
│                                        │ DRUMS     ● │
│      DECK A    TRANSFER    DECK B      │ ■ ■ ■ ■     │
│         ◉       A ─→ B        ◯        │ ■ ■ ■ ■     │
│                                        ├─────────────┤
│                                        │ BASS      ● │
│                                        │ D F G A Bb  │
├────────────────────────────────────────┼─────────────┤
│ SOLO · Lead · “Rising phrase”          │ CHORDS    ● │
│ ███████████████────────  7 / 12 bars   │ Dm Bb F C   │
├────────────────────────────────────────┴─────────────┤
│ LEAD · Bright Mono                                ● │
│ ▯ ▮ ▯ ▮ ▯ ▯ ▮ ▯ ▮ ▯ ▮ ▯ ▯ ▮ ▯ ▮ ▯               │
└──────────────────────────────────────────────────────┘
```

The proportions can change responsively, but the spatial relationship and fixed instrument locations should remain.

## 3. Decks

### Meaning

Each deck is a complete repeating musical scene containing:

- Drum events.
- Bass events.
- Chord events.
- Lead events.
- One Deck Sound Profile for each instrument.

The initial deck length is four bars in 4/4. Later versions may support one, two, or eight bars. Six bars and independent per-track loop lengths are outside the MVP.

### Active and inactive decks

One deck is the primary active scene. The inactive deck remains visible and can receive human recordings or agent cues without affecting the current output.

During a blend transfer, both decks can sound at once.

### Disc display

Each disc should show:

- Four clear bar divisions.
- A rotating playhead.
- A ring or lane for each instrument.
- Solid marks for committed events.
- Outlined marks for cued events.
- Faint marks for globally disabled instruments.
- A clear selected-deck state.

The discs should provide musical information rather than imitate turntable decoration. Literal scratching is outside the MVP because it would interfere with musical scheduling.

## 4. Instruments and global on/off state

Drums, bass, chords, and lead each have a fixed window. Instrument on/off state is global rather than deck-specific.

If bass is off:

- Deck A bass is silent.
- Deck B bass is silent.
- Both bass tracks keep moving silently.
- A deck transfer does not turn bass back on.
- Bass notes and Deck Sound Profiles remain stored.

The on/off control sits in the same top-right corner of each instrument window.

### Indicator states

```text
●       Playing
○       Off
◌ 4     Cued on in four bars
◉ 2     Cued off in two bars
```

Visual rules:

- Solid means the current state.
- Hollow means off.
- An outlined pulse means a future state.
- A small number shows bars until the change.
- The user can click the corner control to override or cancel its pending cue.

There is no separate instrument-cue list.

## 5. Instrument settings

### One visible control set

Each instrument has one live preset and one visible set of controls. Decks do not expose duplicate knobs.

Suggested controls:

| Instrument | Controls |
|---|---|
| Drums | Punch, Tightness, Dirt, Room |
| Bass | Tone, Shape, Glide, Drive |
| Chords | Tone, Attack, Width, Space |
| Lead | Tone, Bite, Motion, Echo |

Each instrument initially has six curated presets. There is no modular patching or large preset browser.

### Deck Sound Profiles

Each deck stores one captured Deck Sound Profile per instrument. A successful recording copies the current live preset and control values into the destination deck.

Example:

```text
Live Lead:    Bright Mono
Deck A Lead:  Soft Pluck
Deck B Lead:  FM Bell
```

Changing the live lead to another sound does not alter Deck A or Deck B.

The most recently completed recording to a deck instrument replaces that instrument's Deck Sound Profile. Because a deck has one profile per instrument, all existing notes for that deck instrument then use the newly captured profile.

Cancelling a recording does not change the profile.

## 6. Playing and recording

### Live playing

- Drum pads trigger the current live drum sound.
- Bass controls play the current live bass sound.
- Chord pads trigger the current live chord sound and selected voicing.
- The bottom keyboard plays the current live lead sound.
- Live playing does not change either deck unless recording is armed.

### Recording target

Before recording, the human chooses:

- Deck A and instrument.
- Deck B and instrument.
- Solo, when recording a non-looping performance is later supported.

### Recording behaviour

- Record musical note events rather than rendered audio.
- Always quantise starts and endings to eighth notes.
- Use 240 ticks per eighth note at 480 PPQ.
- Default to overdub.
- Replace only when the human explicitly selects replace mode or a range.
- Copy the current live settings into the destination Deck Sound Profile when the take commits.
- Treat notes and the profile copy as one undoable action.
- Cancelled takes change nothing.

The human hears the current live sound while recording. After the take commits, the deck reproduces that captured profile independently.

## 7. Stored musical events

### Notes

```ts
type NoteEvent = {
  id: string;
  startTick: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
};
```

Deck note positions are local to the repeating deck loop.

### Chords

Chords are musical events, not fixed global settings. They can be added, removed, or replaced anywhere, like notes.

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

The symbol is stored for later display and agent reasoning. The exact pitches guarantee repeatable playback.

Stored events do not record whether a human or agent created them. Pending agent material is recognisable because it remains in the cue system until execution.

## 8. Global musical time

All cues, including solo notes, use one global musical clock. Solo notes do not use time relative to the beginning of the solo.

```ts
type MusicalTime = {
  cycle: number;
  bar: number;  // 0-23 internally
  tick: number; // 0-1919 in 4/4 at 480 PPQ
};
```

The visible clock can show human-friendly one-based bars:

```text
Cycle 3 · Bar 7 · Beat 2
```

Conversion:

```ts
absoluteBar = cycle * 24 + bar;
absoluteTick = absoluteBar * 1920 + tick;
```

The cycle number is required. Wrapping the bar number alone would make two different occurrences of “bar 7” ambiguous.

### Three relevant positions

- Global musical time says when a cue executes or a solo note sounds.
- Deck-local time says where an event appears inside a repeating deck.
- The active deck phase says which deck bar the listener currently hears.

The agent must receive all three where relevant, along with the current chord context, so its solo material remains harmonically aligned.

## 9. Agent model

### Core rule

The agent only cues. It does not attempt to click pads or move controls at exact real-time moments.

The agent can cue:

- Notes and drum hits onto either deck.
- Chord events onto either deck.
- Removal or replacement of deck events.
- Changes to Deck Sound Profiles.
- Global instrument on/off changes.
- A transfer between decks.
- The beginning of a solo buffer.
- Globally timed notes and chords into the solo buffer.
- An early solo end in unusual cases.

The browser scheduler performs cues on the audio clock.

### No cue manager

There is no visible cue queue, card list, agent panel, or confirmation dialogue for ordinary cues.

Each cue appears directly where its change will happen:

- Deck events appear on the destination disc.
- Instrument on/off cues appear in the instrument's corner.
- Deck Sound Profile cues appear in that instrument's settings.
- Transfers appear between the decks.
- Solo state appears in the solo strip.

## 10. Cue structure

All cues share one outer envelope:

```ts
type Cue = {
  id: string;
  at: MusicalTime;
  action: CueAction;
};
```

`at` is the global time when the action executes. It is never a deck-relative or solo-relative time.

```ts
type CueAction =
  | AddDeckEvents
  | RemoveDeckEvents
  | ReplaceDeckEvents
  | SetInstrumentEnabled
  | SetDeckSoundProfile
  | TransferDeck
  | StartSolo
  | AddSoloEvents
  | EndSoloEarly;
```

### Add deck events

```ts
type MusicalEvent = NoteEvent | ChordEvent;

type AddDeckEvents = {
  type: "add-deck-events";
  deck: "A" | "B";
  instrument: Instrument;
  events: MusicalEvent[];
};
```

The cue's global `at` says when the deck change commits. Event `startTick` values say where the events sit inside the deck's four-bar loop.

### Remove or replace deck events

```ts
type RemoveDeckEvents = {
  type: "remove-deck-events";
  deck: "A" | "B";
  instrument: Instrument;
  eventIds: string[];
};

type ReplaceDeckEvents = {
  type: "replace-deck-events";
  deck: "A" | "B";
  instrument: Instrument;
  fromTick: number;
  toTick: number;
  events: MusicalEvent[];
};
```

### Global instrument state

```ts
type SetInstrumentEnabled = {
  type: "set-instrument-enabled";
  instrument: Instrument;
  enabled: boolean;
};
```

### Deck Sound Profile change

```ts
type SetDeckSoundProfile = {
  type: "set-deck-sound-profile";
  deck: "A" | "B";
  instrument: Instrument;
  profile: DeckSoundProfile;
  transitionTicks?: number;
};
```

### Transfer

```ts
type TransferDeck = {
  type: "transfer-deck";
  destination: "A" | "B";
  style: "cut" | "blend";
  durationTicks: number;
};
```

### Start solo

Starting a solo creates an empty non-looping buffer. It sets the instrument, description, length, and sound, but contains no notes.

```ts
type StartSolo = {
  type: "start-solo";
  soloId: string;
  instrument: Instrument;
  description: string;
  lengthBars: number;
  soundProfile: DeckSoundProfile;
};
```

The `Cue.at` time is the solo's start. Its natural end is calculated from `lengthBars` on the same global clock.

### Add solo events

Solo material uses global event times so the agent can reason about the harmony, active deck, and transfer state without converting into a second local clock.

```ts
type GlobalNoteEvent = Omit<NoteEvent, "startTick"> & {
  start: MusicalTime;
};

type GlobalChordEvent = Omit<ChordEvent, "startTick"> & {
  start: MusicalTime;
};

type AddSoloEvents = {
  type: "add-solo-events";
  soloId: string;
  events: Array<GlobalNoteEvent | GlobalChordEvent>;
};
```

The outer cue's `at` says when the new material becomes committed to the solo buffer. Each event's global `start` says when it sounds.

The scheduler must reject solo events that begin before the solo starts or after its natural end.

### End solo early

```ts
type EndSoloEarly = {
  type: "end-solo-early";
  soloId: string;
};
```

This is an exceptional action. A solo normally ends automatically after `lengthBars`.

## 11. Cue timing defaults

Different changes use different default boundaries while remaining on the same global clock:

| Change | Default boundary |
|---|---|
| Recorded note start/end | Eighth note |
| Agent deck note placement | Eighth note |
| Chord event placement | Eighth note |
| Instrument on/off | Bar |
| Deck Sound Profile change | Bar |
| Solo start | Bar |
| Solo note start | Eighth note |
| Deck transfer | Bar or deck-loop boundary |

The agent may submit a more specific legal time. The scheduler validates and normalises it before accepting the cue.

## 12. Cue indication

Use one visual grammar throughout the interface:

- Solid means current or committed.
- Outlined means cued.
- A small number means bars until execution.
- A moving fill means a transition is underway.
- A brief pulse means execution has completed.

Use one cue accent colour, but never rely on colour alone.

### Deck events

- Current notes and hits are filled.
- Cued notes and hits are outlined in place.
- Material due for replacement becomes faint.
- Outlined events become solid when the cue executes.

### Instrument state

Use the top-right corner control described earlier. The indicator itself contains the cue state and bar countdown.

### Presets and controls

Preset cue:

```text
BASS · Rubber          ●
       → Acid · 4
```

Knob cue:

- Solid marker: current value.
- Hollow marker: cued destination.
- Faint connecting arc: gradual transition.
- Small bar number: time until the transition begins.

### Transfer

The centre transfer control shows direction, time remaining, and transfer progress. There is no transfer card.

## 13. Transfer interaction

The transfer control sits physically between Deck A and Deck B.

MVP transfer styles:

- Cut: switch on the chosen boundary.
- Blend: crossfade over a chosen number of beats or bars.

The solo buffer continues through a transfer. Global instrument on/off state also continues through a transfer.

The human can grab the transfer control while an agent transfer is pending or running. Human input cancels the pending agent transfer and takes immediate control.

## 14. Solo buffer

The solo buffer is independent of both decks and does not loop. It can use drums, bass, chords, or lead.

It should continue across deck transfers by default.

### Visible interface

The solo interface remains a minimal status strip:

```text
SOLO · LEAD · “Rising melodic phrase”
███████████████──────────────  7 / 12 bars
```

It shows only:

- Instrument.
- A short description.
- Progress bar.
- Current and total bars.
- A stop control, shown subtly because early stopping is unusual.

It does not show:

- Notes.
- A waveform.
- A piano roll.
- A second timeline.
- A detailed cue list.
- Capture controls.

### Solo timing

- `StartSolo` defines the global start and bar length.
- The buffer begins empty.
- Separate `AddSoloEvents` cues fill it.
- Every solo event has a global musical start time.
- The agent receives global chord and deck context before creating solo events.
- The solo ends naturally after its declared bar length.
- `EndSoloEarly` exists only for unusual cases.

## 15. Human priority and undo

The human may directly change any visible control at any time.

Rules:

- Human input on a control cancels a pending agent cue for that same control.
- Grabbing the transfer cancels the agent's pending or active transfer.
- Toggling an instrument cancels its pending on/off cue.
- Recording to a deck is never silently replaced by an agent cue.
- Each executed agent cue creates one undoable transaction.
- A dedicated Undo Agent action may reverse the latest executed agent transaction without reversing human performance input.

There is no need to store authorship on committed notes.

## 16. Agent context

Before making cues, the agent should receive a compact state containing:

- Current `MusicalTime`.
- Current absolute bar.
- Current deck phase.
- Active deck.
- Pending transfer, if any.
- Global instrument on/off states.
- Deck-local events for both decks.
- Deck Sound Profiles.
- Current musical key.
- Current and upcoming chord events.
- Active solo ID, instrument, start, end, and description.
- Existing globally timed solo events.

This is enough for the agent to place harmonically and rhythmically coherent cues without reading rendered interface pixels.

## 17. MVP interaction decisions

The first interactive version should implement:

1. Fixed instrument layout.
2. Two four-bar decks.
3. One global 24-bar cycle clock.
4. Eighth-note recording quantisation.
5. Global instrument on/off controls.
6. One live control set and six presets per instrument.
7. Deck Sound Profile capture on completed recordings.
8. Note and chord event cues onto either deck.
9. Cut and blend transfer cues.
10. Minimal solo progress strip.
11. Empty solo creation followed by globally timed solo-event cues.
12. Direct local cue indicators rather than a cue manager.
13. Human override and cue-level undo.

## 18. Deferred interaction ideas

- Variable quantisation.
- Swing and humanisation.
- One-, two-, and eight-bar decks.
- Odd loop lengths.
- Recorded parameter automation.
- Full sound-profile editing on a deck.
- Literal turntable scratching.
- Multiple simultaneous solo buffers.
- Per-track loop lengths.
- Per-note sound profiles.
- Detailed arrangement timeline.

