/** Stable public compatibility facade. Phase 1 intentionally exposes the
 * preserved legacy engine until the independent instrument migrations finish. */
export { LegacySynthEngine, LegacySynthEngine as SynthEngine } from './legacy/audio.ts';
export { HybridAudioEngine, HybridAudioEngine as HybridSynthEngine } from './hybrid-engine.ts';
export { drumNames } from './legacy/audio.ts';
export type { AudioEngine, Controls, DrumModel, Instrument, Parameter, VoiceGroupState, VoiceLane } from './synth/contract.ts';
export type {
  BassGraphProfile,
  BassReleaseDiagnostic,
  BassReleaseWindowAnalysis,
  BassVcaCurve,
  BassVcaRetriggerTiming,
  BassVcaSchedule,
  BassVcaTiming,
} from './legacy/legacy-engine.ts';
export {
  BassVcaController,
  PERSISTENT_BASS_LANES,
  adsrLevelAt,
  analyseBassReleaseWindow,
  bassDeckProfileFingerprint,
  bassGraphProfileFingerprint,
  bassLaneNoteIsAudibleAt,
  bassVcaAutomationTiming,
  bassVcaRetriggerTiming,
  bassVcaSchedule,
  canChokeVoiceGroup,
  countMusicalVoices,
  countMusicalVoicesInLane,
  linearFadeValue,
  releaseEndTime,
  safeReleaseDuration,
  sampledSmoothstepCurve,
  smoothstepDerivative,
  smoothstepProgress,
  smoothstepValue,
  voiceGroupCountsTowardLimit,
  voiceGroupIsTracked,
  voiceGroupReleaseState,
  voiceGroupStopState,
} from './legacy/legacy-engine.ts';
