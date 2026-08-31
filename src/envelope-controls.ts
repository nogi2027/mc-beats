export type EnvelopeFieldKey = 'attackMs' | 'decayMs' | 'sustainLevel' | 'releaseMs';

export type EnvelopeField = {
  key: EnvelopeFieldKey;
  label: 'Attack' | 'Decay' | 'Sustain' | 'Release';
  unit: 'ms' | '%';
};

export const ENVELOPE_FIELDS: readonly EnvelopeField[] = [
  { key: 'attackMs', label: 'Attack', unit: 'ms' },
  { key: 'decayMs', label: 'Decay', unit: 'ms' },
  { key: 'sustainLevel', label: 'Sustain', unit: '%' },
  { key: 'releaseMs', label: 'Release', unit: 'ms' },
];

export const envelopeDisplayValue = (key: EnvelopeFieldKey, value: number) => key === 'sustainLevel' ? value * 100 : value;

export const envelopeParameterValue = (key: EnvelopeFieldKey, value: number) => key === 'sustainLevel' ? value / 100 : value;

export const envelopeDisplayBounds = (key: EnvelopeFieldKey, parameter: { min: number; max: number; step: number }) => ({
  min: envelopeDisplayValue(key, parameter.min),
  max: envelopeDisplayValue(key, parameter.max),
  step: envelopeDisplayValue(key, parameter.step),
});
