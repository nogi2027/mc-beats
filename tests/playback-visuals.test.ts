import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeckSnapshot } from '../src/deck.ts';
import type { SoloState } from '../src/music-types.ts';
import { chordVisualKey, playbackVisuals } from '../src/playback-visuals.ts';

const emptyDeck = (): DeckSnapshot => ({ lengthBars: 4, events: { drums: [], bass: [], chords: [], lead: [] }, profiles: {} });

test('deck visuals follow crossfade visibility and note duration', () => {
  const A = emptyDeck();
  const B = emptyDeck();
  A.events.drums.push({ id: 'kick', startTick: 0, pad: 0, velocity: 1 });
  A.events.bass.push({ id: 'a-bass', startTick: 0, durationTicks: 480, pitch: 36, velocity: 1, articulation: .5 });
  B.events.lead.push({ id: 'b-lead', startTick: 0, durationTicks: 480, pitch: 64, velocity: 1, articulation: 1 });

  const AOnly = playbackVisuals({ decks: { A, B }, phaseTick: 80, absoluteTick: 0, crossfadePosition: 0, solo: null, playing: true });
  assert.deepEqual([...AOnly.deck.drums], [0]);
  assert.deepEqual([...AOnly.deck.bass], [36]);
  assert.equal(AOnly.deck.lead.size, 0);

  const both = playbackVisuals({ decks: { A, B }, phaseTick: 300, absoluteTick: 0, crossfadePosition: .5, solo: null, playing: true });
  assert.equal(both.deck.bass.size, 0);
  assert.deepEqual([...both.deck.lead], [64]);
});

test('AI solo visuals use absolute musical time and chord pitch classes', () => {
  const chordPitches = [62, 65, 69];
  const solo: SoloState = {
    soloId: 'solo-1', instrument: 'chords', description: 'test', lengthBars: 1, start: { cycle: 0, bar: 1, tick: 0 },
    startAbsoluteTick: 1920, endAbsoluteTick: 3840, soundProfile: { presetId: 'warm', controls: {}, parameters: {}, volume: 1 }, status: 'active',
    events: [{ type: 'chord', id: 'solo-chord', start: { cycle: 0, bar: 1, tick: 0 }, durationTicks: 480, symbol: 'Dm', pitches: chordPitches, velocity: 1, articulation: .5 }],
  };
  const empty = emptyDeck();
  const active = playbackVisuals({ decks: { A: empty, B: empty }, phaseTick: 0, absoluteTick: 2100, crossfadePosition: 0, solo, playing: false });
  assert.deepEqual([...active.solo.chords], [chordVisualKey(chordPitches)]);
  const ended = playbackVisuals({ decks: { A: empty, B: empty }, phaseTick: 0, absoluteTick: 2200, crossfadePosition: 0, solo, playing: false });
  assert.equal(ended.solo.chords.size, 0);
});
