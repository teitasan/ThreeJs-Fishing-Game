/** Deterministic camera presets for img2threejs turntable / head crops. */
export const CAMERA_PRESETS = {
  front: {
    id: 'front',
    label: 'Front 0°',
    azimuthDeg: 0,
    elevationDeg: 8,
    margin: 1.15,
    framing: 'body',
  },
  'quarter-plus': {
    id: 'quarter-plus',
    label: 'Quarter +35°',
    azimuthDeg: 35,
    elevationDeg: 12,
    margin: 1.15,
    framing: 'body',
  },
  'quarter-minus': {
    id: 'quarter-minus',
    label: 'Quarter -35°',
    azimuthDeg: -35,
    elevationDeg: 12,
    margin: 1.15,
    framing: 'body',
  },
  right: {
    id: 'right',
    label: 'Right 90°',
    azimuthDeg: 90,
    elevationDeg: 8,
    margin: 1.15,
    framing: 'body',
  },
  'rear-three-quarter': {
    id: 'rear-three-quarter',
    label: 'Rear 3/4 135°',
    azimuthDeg: 135,
    elevationDeg: 10,
    margin: 1.15,
    framing: 'body',
  },
  rear: {
    id: 'rear',
    label: 'Rear 180°',
    azimuthDeg: 180,
    elevationDeg: 8,
    margin: 1.15,
    framing: 'body',
  },
  left: {
    id: 'left',
    label: 'Left 270°',
    azimuthDeg: 270,
    elevationDeg: 8,
    margin: 1.15,
    framing: 'body',
  },
  'head-front': {
    id: 'head-front',
    label: 'Head Front',
    azimuthDeg: 0,
    elevationDeg: 4,
    margin: 0.52,
    framing: 'head',
  },
  'head-quarter': {
    id: 'head-quarter',
    label: 'Head Quarter',
    azimuthDeg: 35,
    elevationDeg: 4,
    margin: 0.52,
    framing: 'head',
  },
};

export const PRESET_ORDER = [
  'front',
  'quarter-plus',
  'quarter-minus',
  'right',
  'rear-three-quarter',
  'rear',
  'left',
  'head-front',
  'head-quarter',
];

/** @param {string} id */
export function resolvePreset(id) {
  if (!id) return null;
  const key = String(id).trim().toLowerCase().replace(/\s+/g, '-');
  return CAMERA_PRESETS[key] ?? null;
}
