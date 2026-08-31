import type { VoiceState } from './contract.ts';
import { SynthVoice } from './voice.ts';

export class VoiceGroup {
  readonly id: string;
  readonly children: SynthVoice[];
  private released = false;
  private choked = false;

  constructor(id: string, children: SynthVoice[] = []) {
    this.id = id;
    this.children = children;
  }

  add(voice: SynthVoice) {
    if (!this.children.includes(voice)) this.children.push(voice);
    return voice;
  }

  get state(): VoiceState {
    if (this.children.length === 0) return 'stopped';
    if (this.children.every((voice) => voice.state === 'stopped')) return 'stopped';
    if (this.children.some((voice) => voice.state === 'releasing')) return 'releasing';
    if (this.children.some((voice) => voice.state === 'scheduled')) return 'scheduled';
    return 'active';
  }

  release(at: number, duration: number, protectLate = false) {
    if (this.released || this.choked) return;
    this.released = true;
    this.children.forEach((voice) => voice.release(at, duration, protectLate));
  }

  choke(at: number, duration = 0.02, protectLate = false) {
    if (this.choked) return;
    this.choked = true;
    this.children.forEach((voice) => voice.choke(at, duration, protectLate));
  }

  stop(at?: number) { this.children.forEach((voice) => voice.stop(at)); }
  dispose() { this.children.forEach((voice) => voice.dispose()); }
}
