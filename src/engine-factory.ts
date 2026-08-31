import type { AudioEngine } from './synth/contract.ts';
import { HybridAudioEngine } from './hybrid-engine.ts';
import { LegacySynthEngine } from './legacy/audio.ts';

/** Select the app engine without coupling the choice to React. */
export const createAppEngine = (search = ''): AudioEngine =>
  new URLSearchParams(search).get('synth') === 'legacy'
    ? new LegacySynthEngine()
    : new HybridAudioEngine();

