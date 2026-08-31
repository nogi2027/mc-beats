const envelopeControls = document.querySelectorAll('[data-envelope]');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const envelopeState = (control) => {
  const attack = Number(control.dataset.attack) / 1000;
  const decay = Number(control.dataset.decay) / 2000;
  const sustain = Number(control.dataset.sustain) / 100;
  const release = Number(control.dataset.release) / 3000;
  const attackX = 18 + attack * 52;
  const decayX = attackX + 15 + decay * (132 - attackX - 15);
  return {
    attackX,
    decayX,
    sustainX: 160,
    sustainY: 10 + (1 - sustain) * 46,
    releaseX: 174 + release * 42,
  };
};

const drawEnvelope = (control) => {
  const state = envelopeState(control);
  control.querySelector('.envelope-path').setAttribute('d', `M4 64 L${state.attackX} 8 L${state.decayX} ${state.sustainY} L${state.sustainX} ${state.sustainY} L${state.releaseX} 64`);
  const points = {
    attack: [state.attackX, 8],
    decay: [state.decayX, state.sustainY],
    sustain: [state.sustainX, state.sustainY],
    release: [state.releaseX, 64],
  };
  Object.entries(points).forEach(([name, [x, y]]) => {
    const point = control.querySelector(`[data-point="${name}"]`);
    point.setAttribute('cx', x);
    point.setAttribute('cy', y);
  });
};

envelopeControls.forEach((control) => {
  control.querySelectorAll('[data-point]').forEach((point) => {
    point.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      point.setPointerCapture(event.pointerId);
    });
    point.addEventListener('pointermove', (event) => {
      if (!point.hasPointerCapture(event.pointerId)) return;
      const svg = control.querySelector('svg');
      const rect = svg.getBoundingClientRect();
      const x = clamp(((event.clientX - rect.left) / rect.width) * 220, 4, 216);
      const y = clamp(((event.clientY - rect.top) / rect.height) * 72, 8, 56);
      const state = envelopeState(control);

      if (point.dataset.point === 'attack') {
        control.dataset.attack = String(Math.round(((clamp(x, 18, 70) - 18) / 52) * 1000));
      } else if (point.dataset.point === 'decay') {
        const start = state.attackX + 15;
        control.dataset.decay = String(Math.round(((clamp(x, start, 132) - start) / (132 - start)) * 2000));
      } else if (point.dataset.point === 'sustain') {
        control.dataset.sustain = String(Math.round(clamp(1 - (y - 10) / 46, 0, 1) * 100));
      } else if (point.dataset.point === 'release') {
        control.dataset.release = String(Math.round(((clamp(x, 174, 216) - 174) / 42) * 3000));
      }
      drawEnvelope(control);
    });
  });
  drawEnvelope(control);
});

const heatmap = document.querySelector('.heatmap-grid');
if (heatmap) {
  const columns = 28;
  const rows = 10;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = document.createElement('i');
      const lowBand = Math.pow((rows - row) / rows, 2) * 48;
      const pulse = Math.max(0, Math.sin(column * 1.17 + row * 0.73)) * 28;
      const event = [3, 9, 15, 22, 27].includes(column) ? Math.max(0, 30 - row * 3) : 0;
      cell.style.setProperty('--heat', `${Math.round(clamp(10 + lowBand + pulse + event, 8, 96))}%`);
      heatmap.append(cell);
    }
  }
}

const shortcutLayouts = [
  ['.drums .drum-pad', ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V']],
  ['.bass-keys button', ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"]],
  ['.lead .piano button', ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';']],
  ['.lead .piano i', ['W', 'E', 'T', 'Y', 'U', 'O', 'P']],
  ['.chord-pads button', ['1', '2', '3', '4', '5', '6', '7']],
];

shortcutLayouts.forEach(([selector, keys]) => {
  document.querySelectorAll(selector).forEach((element, index) => {
    element.dataset.shortcut = keys[index];
  });
});

const focusableInstruments = [...document.querySelectorAll('[data-focusable]')];
let focusedInstrument = document.querySelector('.lead');

const setFocusedInstrument = (instrument) => {
  if (!instrument) return;
  focusedInstrument = instrument;
  focusableInstruments.forEach((candidate) => {
    candidate.classList.toggle('is-focused', candidate === instrument);
    candidate.classList.toggle('is-muted', candidate !== instrument);
  });
};

focusableInstruments.forEach((instrument) => {
  instrument.addEventListener('pointerdown', () => setFocusedInstrument(instrument));
  instrument.addEventListener('focusin', () => setFocusedInstrument(instrument));
});
setFocusedInstrument(focusedInstrument);

const normalizedKey = (key) => key.length === 1 ? key.toUpperCase() : key;
document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  const key = normalizedKey(event.key);
  const target = [...focusedInstrument.querySelectorAll('[data-shortcut]')]
    .find((element) => element.dataset.shortcut === key);
  if (!target) return;
  event.preventDefault();
  target.classList.add('shortcut-pressed');
});

document.addEventListener('keyup', (event) => {
  const key = normalizedKey(event.key);
  document.querySelectorAll(`[data-shortcut="${CSS.escape(key)}"]`)
    .forEach((element) => element.classList.remove('shortcut-pressed'));
});

window.addEventListener('blur', () => {
  document.querySelectorAll('.shortcut-pressed').forEach((element) => element.classList.remove('shortcut-pressed'));
});

const effectSwitch = document.querySelector('.effect-switch');
const switchEffects = ['CROSSFADE', 'FILTER', 'ECHO', 'CUT'];
let switchEffectIndex = 0;
effectSwitch?.addEventListener('click', () => {
  switchEffectIndex = (switchEffectIndex + 1) % switchEffects.length;
  const effect = switchEffects[switchEffectIndex];
  effectSwitch.querySelector('strong').textContent = effect;
  effectSwitch.setAttribute('aria-label', `Switch effect: ${effect.toLowerCase()}`);
});

const designWidth = 1440;
const viewport = document.querySelector('.mockup-viewport');
const pageShell = document.querySelector('.page-shell');
let resizeFrame = 0;

const fitMockupToWindow = () => {
  if (!viewport || !pageShell) return;
  const availableWidth = Math.max(1, window.innerWidth - 32);
  const scale = Math.min(1, availableWidth / designWidth);
  pageShell.style.transform = `scale(${scale})`;
  viewport.style.width = `${designWidth * scale}px`;
  viewport.style.height = `${pageShell.scrollHeight * scale}px`;
};

const scheduleMockupFit = () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(fitMockupToWindow);
};

window.addEventListener('resize', scheduleMockupFit);
fitMockupToWindow();
document.fonts?.ready.then(fitMockupToWindow);
