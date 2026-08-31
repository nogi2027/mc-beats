import type { VoiceState } from './contract.ts';

export const MIN_ENVELOPE_TIME = 0.000001;
export const MIN_GAIN_TRANSITION_SECONDS = 0.001;

export type EnvelopeSegment = {
  kind: 'hold' | 'ramp';
  from: number;
  to: number;
  start: number;
  end: number;
  curve?: 'smoothstep' | 'exponential';
};

export type EnvelopeStage = 'attack' | 'decay' | 'sustain' | 'release' | 'silence';

export type EnvelopeSchedule = {
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
  attackCurve?: 'linear' | 'exponential';
  decayCurve?: 'linear' | 'exponential';
};

export const clampEnvelopeValue = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const safeEnvelopeTime = (value: number, fallback = MIN_ENVELOPE_TIME) => Number.isFinite(value) ? Math.max(0, value) : fallback;
export const safeReleaseTime = (value: number) => Math.max(0.012, safeEnvelopeTime(value, 0.012));
export const safeAttackTime = (value: number) => Math.max(MIN_GAIN_TRANSITION_SECONDS, safeEnvelopeTime(value));
export const safeDecayTime = (value: number, sustain: number) => sustain === 1 ? safeEnvelopeTime(value) : Math.max(MIN_GAIN_TRANSITION_SECONDS, safeEnvelopeTime(value));
export const safeAutomationTime = (requestedAt: number, now: number, sampleRate: number, protectLate = false) => {
  const requested = Number.isFinite(requestedAt) ? requestedAt : now;
  const current = Number.isFinite(now) ? now : 0;
  const guard = protectLate ? (128 * 2) / (Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000) : 0;
  const scheduledAt = protectLate ? Math.max(requested, current + guard) : requested;
  return { requestedAt: requested, scheduledAt, safetyOffsetSeconds: scheduledAt - requested };
};

export const linearValueAt = (from: number, to: number, start: number, end: number, time: number) => {
  if (end <= start) return to;
  const progress = Math.max(0, Math.min(1, (time - start) / (end - start)));
  return from + (to - from) * progress;
};

const exponentialValueAt = (from: number, to: number, start: number, end: number, time: number) => {
  if (end <= start) return to;
  const progress = Math.max(0, Math.min(1, (time - start) / (end - start)));
  const safeFrom = Math.max(MIN_GAIN_TRANSITION_SECONDS / 10, Math.abs(from));
  const safeTo = Math.max(MIN_GAIN_TRANSITION_SECONDS / 10, Math.abs(to));
  return Math.sign(from || 1) * Math.pow(safeTo / safeFrom, progress) * (from < 0 || to < 0 ? -1 : 1);
};

/** Cubic fade with zero slope at both endpoints. */
export const smoothstepValueAt = (from: number, to: number, start: number, end: number, time: number) => {
  if (end <= start) return to;
  if (time <= start) return from;
  if (time >= end) return to;
  const progress = (time - start) / (end - start);
  const eased = progress * progress * (3 - 2 * progress);
  return from + (to - from) * eased;
};

export const smoothstepCurve = (from: number, to: number, sampleCount = 65) => {
  const count = Math.max(2, Math.floor(sampleCount));
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1);
    const eased = progress * progress * (3 - 2 * progress);
    values[index] = from + (to - from) * eased;
  }
  return values;
};

export type SmoothFadeResult = {
  start: number;
  end: number;
  usedCancelAndHold: boolean;
  usedCurve: boolean;
};

/**
 * Schedules a voice-local fade. Modern Web Audio keeps the browser's actual
 * held value at the transition. The fallback anchors only to the caller's
 * voice-local value because old browsers lack cancelAndHoldAtTime.
 */
export const scheduleSmoothFade = (
  parameter: AudioParam,
  start: number,
  duration: number,
  from: number,
  to = 0,
): SmoothFadeResult => {
  const safeStart = Number.isFinite(start) ? start : 0;
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const safeEnd = safeStart + safeDuration;
  const safeFrom = Number.isFinite(from) ? from : 0;
  const safeTo = Number.isFinite(to) ? to : 0;
  const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
  const usedCancelAndHold = typeof controlled.cancelAndHoldAtTime === 'function';

  if (usedCancelAndHold) controlled.cancelAndHoldAtTime(safeStart);
  else {
    controlled.cancelScheduledValues(safeStart);
    controlled.setValueAtTime(safeFrom, safeStart);
  }

  if (safeDuration <= MIN_ENVELOPE_TIME || safeFrom === safeTo) {
    controlled.setValueAtTime(safeTo, safeStart);
    return { start: safeStart, end: safeStart, usedCancelAndHold, usedCurve: false };
  }

  const curveSetter = controlled.setValueCurveAtTime;
  if (typeof curveSetter === 'function') {
    try {
      curveSetter.call(controlled, smoothstepCurve(safeFrom, safeTo), safeStart, safeDuration);
      return { start: safeStart, end: safeEnd, usedCancelAndHold, usedCurve: true };
    } catch {
      // Some Web Audio implementations reject a replacement curve when a
      // prior curve starts at the same instant, even after
      // cancelAndHoldAtTime. Clear the rejected curve, re-anchor to this
      // voice's analytic value, and use a safe linear fallback. This path is
      // only a browser compatibility fallback, not the normal C1 fade path.
      try { controlled.cancelScheduledValues(safeStart); } catch { /* best effort */ }
      controlled.setValueAtTime(safeFrom, safeStart);
      controlled.linearRampToValueAtTime(safeTo, safeEnd);
      return { start: safeStart, end: safeEnd, usedCancelAndHold, usedCurve: false };
    }
  }

  // The oldest fallback still uses an explicit value from this voice's model.
  controlled.linearRampToValueAtTime(safeTo, safeEnd);
  return { start: safeStart, end: safeEnd, usedCancelAndHold, usedCurve: false };
};

export const envelopeStageAt = (elapsed: number, schedule: EnvelopeSchedule, releaseAt: number | null = null, releaseEnd: number | null = null): EnvelopeStage => {
  const time = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  const attack = safeAttackTime(schedule.attackSeconds);
  const decay = safeDecayTime(schedule.decaySeconds, clampEnvelopeValue(schedule.sustain));
  if (releaseEnd !== null && time >= releaseEnd) return 'silence';
  if (releaseAt !== null && time >= releaseAt) return 'release';
  if (time < attack) return 'attack';
  if (time < attack + decay) return 'decay';
  return 'sustain';
};

/** A pure, voice-local ADSR model used by the native scheduling fallback. */
export const envelopeValueAt = (start: number, time: number, schedule: EnvelopeSchedule, peak = 1, releaseAt: number | null = null, releaseEnd: number | null = null): number => {
  const elapsed = Math.max(0, (Number.isFinite(time) ? time : start) - start);
  const attack = safeAttackTime(schedule.attackSeconds);
  const decay = safeDecayTime(schedule.decaySeconds, clampEnvelopeValue(schedule.sustain));
  const sustain = clampEnvelopeValue(schedule.sustain) * clampEnvelopeValue(peak);
  if (releaseEnd !== null && elapsed >= releaseEnd) return 0;
  if (releaseAt !== null && elapsed >= releaseAt) {
    const from: number = envelopeValueAt(start, start + releaseAt, schedule, peak);
    const span = Math.max(MIN_ENVELOPE_TIME, releaseEnd === null ? schedule.releaseSeconds : releaseEnd - releaseAt);
    return smoothstepValueAt(from, 0, releaseAt, releaseAt + span, elapsed);
  }
  if (elapsed < attack) {
    if (schedule.attackCurve === 'exponential') {
      const floor = Math.min(clampEnvelopeValue(peak), .0001);
      const preAttack = Math.min(attack * .25, MIN_GAIN_TRANSITION_SECONDS);
      if (elapsed < preAttack) return linearValueAt(0, floor, 0, preAttack, elapsed);
      return exponentialValueAt(floor, clampEnvelopeValue(peak), preAttack, attack, elapsed);
    }
    return linearValueAt(0, clampEnvelopeValue(peak), 0, attack, elapsed);
  }
  if (elapsed < attack + decay) {
    return schedule.decayCurve === 'exponential'
      ? exponentialValueAt(clampEnvelopeValue(peak), sustain, attack, attack + decay, elapsed)
      : linearValueAt(clampEnvelopeValue(peak), sustain, attack, attack + decay, elapsed);
  }
  return sustain;
};

/**
 * A single voice's ADSR. It never writes another voice's parameters and has
 * no reset operation. The timeline is kept only for the old-browser fallback
 * and diagnostics; browsers with cancelAndHoldAtTime own the actual value.
 */
export class VoiceEnvelope {
  readonly parameter?: AudioParam;
  private segments: EnvelopeSegment[] = [];
  private released = false;
  private choked = false;
  private stopped = false;
  private lastRelease: { start: number; end: number } | null = null;
  private fallbackValue = 0;
  private startTime = 0;
  private scheduleState: EnvelopeSchedule = { attackSeconds: 0.005, decaySeconds: 0.05, sustain: 1, releaseSeconds: 0.1 };
  private peak = 1;

  constructor(parameter?: AudioParam, initialValue = 0) {
    this.parameter = parameter;
    this.fallbackValue = clampEnvelopeValue(initialValue);
    if (parameter) parameter.setValueAtTime(this.fallbackValue, 0);
  }

  get state(): VoiceState { return this.stopped ? 'stopped' : this.released || this.choked ? 'releasing' : 'active'; }
  get isReleased() { return this.released || this.choked; }

  private valueAtModel(time: number) {
    if (this.segments.length === 0) return this.fallbackValue;
    let value = this.fallbackValue;
    const segments = [...this.segments].sort((left, right) => left.start - right.start);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (time < segment.start) break;
      value = segment.kind === 'ramp'
        ? segment.curve === 'smoothstep'
          ? smoothstepValueAt(segment.from, segment.to, segment.start, segment.end, time)
          : segment.curve === 'exponential'
            ? exponentialValueAt(segment.from, segment.to, segment.start, segment.end, time)
            : linearValueAt(segment.from, segment.to, segment.start, segment.end, time)
        : segment.to;
      const next = segments[index + 1];
      if (time < segment.end && (!next || next.start > time)) break;
    }
    return clampEnvelopeValue(value);
  }

  valueAt(time: number) { return this.valueAtModel(Number.isFinite(time) ? time : this.startTime); }
  stageAt(time: number) {
    const at = Number.isFinite(time) ? time : this.startTime;
    const release = this.lastRelease;
    return envelopeStageAt(at - this.startTime, this.scheduleState, release ? release.start - this.startTime : null, release ? release.end - this.startTime : null);
  }
  timeline() { return this.segments.map((segment) => ({ ...segment })); }

  noteOn(start: number, schedule: EnvelopeSchedule, peak = 1) {
    if (this.stopped) return;
    const at = Number.isFinite(start) ? start : 0;
    this.startTime = at;
    this.scheduleState = { ...schedule, attackSeconds: safeAttackTime(schedule.attackSeconds), decaySeconds: safeDecayTime(schedule.decaySeconds, clampEnvelopeValue(schedule.sustain)), releaseSeconds: safeReleaseTime(schedule.releaseSeconds), sustain: clampEnvelopeValue(schedule.sustain) };
    this.peak = clampEnvelopeValue(peak);
    this.released = false;
    this.choked = false;
    this.lastRelease = null;
    this.segments = [];
    const attackEnd = at + this.scheduleState.attackSeconds;
    const decayEnd = attackEnd + this.scheduleState.decaySeconds;
    const attackCurve = this.scheduleState.attackCurve ?? 'linear';
    const decayCurve = this.scheduleState.decayCurve ?? 'linear';
    const attackFloor = Math.min(this.peak, .0001);
    const preAttack = Math.min(this.scheduleState.attackSeconds * .25, MIN_GAIN_TRANSITION_SECONDS);
    if (attackCurve === 'exponential') {
      this.segments.push({ kind: 'ramp', from: 0, to: attackFloor, start: at, end: at + preAttack });
      this.segments.push({ kind: 'ramp', from: attackFloor, to: this.peak, start: at + preAttack, end: attackEnd, curve: 'exponential' });
    } else {
      this.segments.push({ kind: 'ramp', from: 0, to: this.peak, start: at, end: attackEnd });
    }
    this.segments.push({ kind: 'ramp', from: this.peak, to: this.scheduleState.sustain * this.peak, start: attackEnd, end: decayEnd, curve: decayCurve === 'exponential' ? 'exponential' : undefined });
    if (this.parameter) {
      this.parameter.setValueAtTime(0, at);
      if (attackCurve === 'exponential') {
        this.parameter.linearRampToValueAtTime(attackFloor, at + preAttack);
        this.parameter.exponentialRampToValueAtTime(this.peak, attackEnd);
      } else {
        this.parameter.linearRampToValueAtTime(this.peak, attackEnd);
      }
      if (decayCurve === 'exponential') this.parameter.exponentialRampToValueAtTime(Math.max(.0001, this.scheduleState.sustain * this.peak), decayEnd);
      else this.parameter.linearRampToValueAtTime(this.scheduleState.sustain * this.peak, decayEnd);
    }
  }

  release(at: number, duration = this.scheduleState.releaseSeconds) {
    if (this.stopped || this.released || this.choked) return this.lastRelease;
    return this.scheduleSilence(at, duration);
  }

  private scheduleSilence(at: number, duration: number) {
    const when = Number.isFinite(at) ? at : this.startTime;
    const releaseDuration = safeReleaseTime(duration);
    const end = when + releaseDuration;
    const from = this.valueAt(when);
    this.released = true;
    this.lastRelease = { start: when, end };
    this.segments = this.segments.filter((segment) => segment.start < when);
    this.segments.push({ kind: 'ramp', from, to: 0, start: when, end, curve: 'smoothstep' });
    if (this.parameter) {
      scheduleSmoothFade(this.parameter, when, releaseDuration, from, 0);
    }
    return this.lastRelease;
  }

  choke(at: number, duration = 0.02) {
    if (this.stopped) return this.lastRelease;
    const result = this.scheduleSilence(at, Math.max(0.012, duration));
    this.choked = true;
    return result;
  }

  markStopped() { this.stopped = true; }
}
