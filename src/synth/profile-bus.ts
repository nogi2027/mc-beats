import type { DeckSoundProfile } from '../deck.ts';

export type ProfileBusSnapshot = Readonly<{
  fingerprint: string;
  profile?: Readonly<DeckSoundProfile>;
}>;

export const cloneAndFreezeProfile = (profile?: DeckSoundProfile): Readonly<DeckSoundProfile> | undefined => {
  if (!profile) return undefined;
  const clone = JSON.parse(JSON.stringify(profile)) as DeckSoundProfile;
  const freeze = (value: unknown): unknown => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value as Record<string, unknown>).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(clone) as Readonly<DeckSoundProfile>;
};

/** Small ownership wrapper for an immutable profile/lane destination. */
export class ProfileBus {
  readonly output: GainNode;
  readonly fingerprint: string;
  readonly profile?: Readonly<DeckSoundProfile>;
  private users = 0;
  private tailUntil = 0;
  private disposed = false;

  constructor(context: BaseAudioContext, snapshot: ProfileBusSnapshot) {
    this.output = context.createGain();
    this.output.gain.value = snapshot.profile?.volume ?? 1;
    this.fingerprint = snapshot.fingerprint;
    this.profile = cloneAndFreezeProfile(snapshot.profile as DeckSoundProfile | undefined);
  }

  retain() { if (!this.disposed) this.users += 1; return this; }
  release(tailUntil = 0) { this.users = Math.max(0, this.users - 1); this.tailUntil = Math.max(this.tailUntil, tailUntil); return this; }
  canDispose(at: number) { return this.users === 0 && at >= this.tailUntil; }
  disconnect(at = Number.POSITIVE_INFINITY) {
    if (this.disposed || !this.canDispose(at)) return false;
    this.disposed = true;
    try { this.output.disconnect(); } catch { /* already disconnected */ }
    return true;
  }
  snapshot() { return { fingerprint: this.fingerprint, profile: this.profile ? JSON.parse(JSON.stringify(this.profile)) as DeckSoundProfile : undefined, users: this.users, tailUntil: this.tailUntil }; }
}

export type LaneBus = {
  lane: string;
  output: GainNode;
  profileBuses: Map<string, ProfileBus>;
};
