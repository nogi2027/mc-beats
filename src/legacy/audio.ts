/**
 * @deprecated Phase 1 compatibility entry point for the pre-independent
 * engine. It remains available for A/B comparison and rollback.
 */
export { LegacySynthEngine, LegacySynthEngine as default, drumNames } from './legacy-engine.ts';
export type { AudioEngine, Controls, DrumModel, Instrument, Parameter, VoiceGroupState, VoiceLane } from '../synth/contract';
