import type { Instrument, VoiceLane } from './contract.ts';
import { SynthVoice } from './voice.ts';

export type VoicePoolLimits = Partial<Record<Instrument, number>>;
export type VoicePoolTailLimits = Partial<Record<Instrument, number>>;
export type VoicePoolAddResult =
  | { status: 'accepted'; voice: SynthVoice }
  | { status: 'rejected'; voice: SynthVoice; reason: string };
export type VoicePoolManyAddResult =
  | { status: 'accepted'; voices: SynthVoice[]; stolen: SynthVoice[] }
  | { status: 'rejected'; voices: SynthVoice[]; reason: string };

const defaultLimits: Record<Instrument, number> = {
  bass: 8,
  lead: 8,
  chords: 24,
  drums: 32,
  metronome: 4,
};

// These are retained cleanup objects, not musical voices. They are sized for
// the longest supported four-bar patterns and remain finite under a burst.
const defaultTailLimits: Record<Instrument, number> = {
  bass: 8,
  lead: 64,
  chords: 192,
  drums: 64,
  metronome: 16,
};

const laneKey = (instrument: Instrument, lane: VoiceLane) => `${instrument}:${lane}`;

type Reservation = {
  voice: SynthVoice;
  sequence: number;
  startAt: number;
  endAt: number;
  incoming: boolean;
  forcedAt?: number;
};

export class VoicePool {
  private readonly voices = new Map<string, { voice: SynthVoice; sequence: number }>();
  /** A forced choke is only retiring once its scheduled audio time arrives. */
  private readonly forcedRetiring = new Map<string, number>();
  private readonly limits: Record<Instrument, number>;
  private readonly tailLimits: Record<Instrument, number>;
  private readonly laneLimits = new Map<string, number>();
  private readonly laneTailLimits = new Map<string, number>();
  private sequence = 0;

  constructor(limits: VoicePoolLimits = {}, tailLimits: VoicePoolTailLimits = {}) {
    this.limits = { ...defaultLimits, ...limits };
    this.tailLimits = { ...defaultTailLimits, ...tailLimits };
  }

  setLimit(instrument: Instrument, lane: VoiceLane, limit: number) {
    this.laneLimits.set(laneKey(instrument, lane), Math.max(1, Math.floor(limit)));
  }

  setTailLimit(instrument: Instrument, lane: VoiceLane, limit: number) {
    this.laneTailLimits.set(laneKey(instrument, lane), Math.max(1, Math.floor(limit)));
  }

  private limitFor(instrument: Instrument, lane: VoiceLane) { return this.laneLimits.get(laneKey(instrument, lane)) ?? this.limits[instrument]; }

  private removeStopped() {
    for (const [id, entry] of this.voices) {
      if (entry.voice.state === 'stopped') {
        this.voices.delete(id);
        this.forcedRetiring.delete(id);
      }
    }
  }

  private laneVoices(instrument: Instrument, lane: VoiceLane) {
    return [...this.voices.values()].filter(({ voice }) => voice.instrument === instrument && voice.lane === lane);
  }

  private now() { return [...this.voices.values()][0]?.voice.audioTime ?? 0; }

  private tailLimitFor(instrument: Instrument, lane: VoiceLane) { return this.laneTailLimits.get(laneKey(instrument, lane)) ?? this.tailLimits[instrument]; }

  private isForcedRetiringAt(id: string, at: number) {
    const retireAt = this.forcedRetiring.get(id);
    return retireAt !== undefined && retireAt <= at;
  }

  tryAdd(voice: SynthVoice): VoicePoolAddResult {
    // Preserve the single-add API's explicit duplicate error. In particular,
    // do not let add() dispose an already-retained voice when a caller
    // accidentally submits the same object twice.
    this.removeStopped();
    if (this.voices.has(voice.id)) throw new Error(`Duplicate voice id: ${voice.id}`);
    const result = this.tryAddMany([voice], voice.timing.startAt);
    if (result.status === 'accepted') return { status: 'accepted', voice };
    return { status: 'rejected', voice, reason: result.reason };
  }

  /** Atomically reserve a group of voices. Preflight has no side effects:
   * neither victims nor new voices are touched until the entire batch fits.
   *
   * Reservations are intervals, not snapshots at onset. This supports
   * out-of-order future scheduling: a note inserted at t=5 is checked again
   * when it overlaps a reservation beginning at t=10. */
  tryAddMany(voices: SynthVoice[], at?: number): VoicePoolManyAddResult {
    this.removeStopped();
    if (voices.length === 0) return { status: 'rejected', voices, reason: 'Cannot allocate an empty voice batch.' };
    const first = voices[0];
    const duplicateIds = new Set<string>();
    for (const voice of voices) {
      if (duplicateIds.has(voice.id) || this.voices.has(voice.id)) {
        return { status: 'rejected', voices, reason: `Duplicate voice id: ${voice.id}` };
      }
      duplicateIds.add(voice.id);
      if (voice.state === 'stopped') return { status: 'rejected', voices, reason: `Cannot add stopped voice ${voice.id}.` };
      if (voice.instrument !== first.instrument || voice.lane !== first.lane) {
        return { status: 'rejected', voices, reason: 'A voice batch must use one instrument and lane.' };
      }
    }
    const startAt = Number.isFinite(at) ? at as number : first.timing.startAt;
    const limit = this.limitFor(first.instrument, first.lane);
    if (voices.length > limit) return { status: 'rejected', voices, reason: `Voice batch exceeds ${first.instrument}:${first.lane} limit.` };
    const laneVoices = this.laneVoices(first.instrument, first.lane);
    const reservations: Reservation[] = laneVoices.map(({ voice, sequence }) => {
      const forcedAt = this.forcedRetiring.get(voice.id);
      const naturalEnd = voice.timing.releaseEndAt ?? Number.POSITIVE_INFINITY;
      return { voice, sequence, startAt: voice.timing.startAt, endAt: Math.min(naturalEnd, forcedAt ?? Number.POSITIVE_INFINITY), incoming: false, forcedAt };
    });
    const incomingReservations: Reservation[] = voices.map((voice, index) => ({
      voice,
      sequence: this.sequence + index,
      startAt: voice.timing.startAt,
      endAt: voice.timing.releaseEndAt ?? Number.POSITIVE_INFINITY,
      incoming: true,
    }));
    const allReservations = [...reservations, ...incomingReservations];
    const boundaries = [...new Set(allReservations.flatMap((reservation) => [reservation.startAt, reservation.endAt].filter(Number.isFinite)))].sort((left, right) => left - right);
    const plannedChokes = new Map<string, number>();
    const activeAt = (time: number) => allReservations.filter((reservation) => {
      const end = reservation.forcedAt === undefined ? reservation.endAt : Math.min(reservation.endAt, reservation.forcedAt);
      return reservation.startAt <= time && time < end;
    });
    const reject = (reason: string): VoicePoolManyAddResult => ({ status: 'rejected', voices, reason });

    // Check every interval boundary. A future voice can be silent at the new
    // onset yet still conflict when its own onset arrives later.
    for (const boundary of boundaries) {
      let active = activeAt(boundary);
      const incomingAtBoundary = active.filter((reservation) => reservation.incoming).length;
      if (incomingAtBoundary > limit) return reject(`Voice batch exceeds ${first.instrument}:${first.lane} limit at ${boundary}.`);
      while (active.length > limit) {
        const candidates = active.filter((reservation) => !reservation.incoming && !plannedChokes.has(reservation.voice.id));
        if (candidates.length === 0) return reject(`No atomic voice allocation available for ${first.instrument}:${first.lane} at ${boundary}.`);
        candidates.sort((left, right) => {
          const leftReleasing = left.voice.isRetiringAt(boundary) ? 0 : 1;
          const rightReleasing = right.voice.isRetiringAt(boundary) ? 0 : 1;
          return leftReleasing - rightReleasing || left.sequence - right.sequence;
        });
        const victim = candidates[0];
        plannedChokes.set(victim.voice.id, boundary);
        victim.forcedAt = boundary;
        active = activeAt(boundary);
      }
    }

    // Choking a new active victim creates one retained cleanup object unless
    // it was already releasing/retained or already had a later forced choke.
    const retainedAtOnset = laneVoices.filter(({ voice }) => voice.isRetainedTailAt(startAt) || this.isForcedRetiringAt(voice.id, startAt)).length;
    const newTailCount = [...plannedChokes].filter(([id, chokeAt]) => {
      const entry = laneVoices.find(({ voice }) => voice.id === id);
      if (!entry) return false;
      const wasAlreadyForced = this.forcedRetiring.has(id);
      return !wasAlreadyForced && !entry.voice.isRetiringAt(chokeAt) && !entry.voice.isRetainedTailAt(chokeAt);
    }).length;
    if (retainedAtOnset + newTailCount > this.tailLimitFor(first.instrument, first.lane)) {
      return reject(`Retained tail limit reached for ${first.instrument}:${first.lane}.`);
    }
    // Commit phase begins only after every rejection condition above passed.
    const stolen = [...plannedChokes].map(([id]) => this.voices.get(id)!.voice);
    plannedChokes.forEach((chokeAt, id) => {
      const victim = this.voices.get(id)!.voice;
      victim.choke(chokeAt, 0.012);
      this.forcedRetiring.set(victim.id, chokeAt);
    });
    voices.forEach((voice) => {
      const entry = { voice, sequence: this.sequence++ };
      this.voices.set(voice.id, entry);
      voice.onStopped(() => {
        this.voices.delete(voice.id);
        this.forcedRetiring.delete(voice.id);
      });
    });
    return { status: 'accepted', voices: [...voices], stolen };
  }

  add(voice: SynthVoice) {
    const result = this.tryAdd(voice);
    if (result.status === 'rejected') {
      voice.dispose();
      throw new Error(result.reason);
    }
    return result.voice;
  }

  remove(id: string) {
    const voice = this.voices.get(id)?.voice;
    if (!voice) return false;
    voice.stop();
    if (voice.state === 'stopped') {
      this.voices.delete(id);
      this.forcedRetiring.delete(id);
    }
    return true;
  }
  get(id: string) { return this.voices.get(id)?.voice; }
  all() { this.removeStopped(); return [...this.voices.values()].sort((left, right) => left.sequence - right.sequence).map(({ voice }) => voice); }
  byLane(lane: VoiceLane) { return this.all().filter((voice) => voice.lane === lane); }
  byInstrument(instrument: Instrument) { return this.all().filter((voice) => voice.instrument === instrument); }
  count(instrument?: Instrument, lane?: VoiceLane, includeScheduled = true) {
    return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && (includeScheduled || voice.state !== 'scheduled')).length;
  }
  forcedRetiringCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) {
    return this.all().filter((voice) => this.isForcedRetiringAt(voice.id, at) && (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane)).length;
  }
  activeCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && voice.stateAt(at) === 'active' && voice.isMusicallyAllocatedAt(at) && !this.isForcedRetiringAt(voice.id, at)).length; }
  scheduledCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && voice.stateAt(at) === 'scheduled').length; }
  allocatedCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && voice.isMusicallyAllocatedAt(at) && !this.isForcedRetiringAt(voice.id, at)).length; }
  retiringCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && voice.isRetiringAt(at)).length; }
  retainedTailCount(instrument?: Instrument, lane?: VoiceLane, at = this.now()) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane) && (voice.isRetainedTailAt(at) || this.isForcedRetiringAt(voice.id, at))).length; }
  retainedTailLimit(instrument: Instrument, lane: VoiceLane) { return this.tailLimitFor(instrument, lane); }
  retainedCount(instrument?: Instrument, lane?: VoiceLane) { return this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane)).length; }
  snapshot() { return this.all().map((voice) => ({ id: voice.id, instrument: voice.instrument, lane: voice.lane, state: voice.state, startAt: voice.timing.startAt, noteOffAt: voice.timing.noteOffAt, stopAt: voice.timing.stopAt })); }
  stop(instrument?: Instrument, lane?: VoiceLane, at?: number) {
    this.all().filter((voice) => (!instrument || voice.instrument === instrument) && (!lane || voice.lane === lane)).forEach((voice) => voice.stop(at));
  }
  clear() { this.stop(); }
  dispose() { this.all().forEach((voice) => voice.dispose()); }
  forceDispose() { this.all().forEach((voice) => voice.forceDispose()); this.removeStopped(); }
}
