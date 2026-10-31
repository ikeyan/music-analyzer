// 41 平均律 (41edo) のピッチ格子。step は C0 (= A440 基準の 16.3516Hz) からの 41edo 段数で、
// C4 = 164、1 step = 1200/41 ≈ 29.27 cent

export const EDO = 41;
export const C0_HZ = 440 * 2 ** (-(9 + 4 * 12) / 12);
export const EDO41_STEP_CENTS = 1200 / EDO;

export function edo41StepToHz(step: number): number {
  return C0_HZ * 2 ** (step / EDO);
}

export function hzToEdo41Step(hz: number): number {
  return EDO * Math.log2(hz / C0_HZ);
}

// ups and downs 記法 (Kite Giedraitis)。41edo は # = 4 step、b = -4 step、^/v = ±1 step で
// 全 41 度が高々 1 個の ^/v で表せる
const DEGREE_NAMES = [
  "C",
  "^C",
  "vDb",
  "Db",
  "C#",
  "^C#",
  "vD",
  "D",
  "^D",
  "vEb",
  "Eb",
  "D#",
  "^D#",
  "vE",
  "E",
  "^E",
  "vF",
  "F",
  "^F",
  "vGb",
  "Gb",
  "F#",
  "^F#",
  "vG",
  "G",
  "^G",
  "vAb",
  "Ab",
  "G#",
  "^G#",
  "vA",
  "A",
  "^A",
  "vBb",
  "Bb",
  "A#",
  "^A#",
  "vB",
  "B",
  "^B",
  "vC",
] as const;

export function edo41Degree(step: number): number {
  return ((step % EDO) + EDO) % EDO;
}

export function edo41Octave(step: number): number {
  return Math.floor(step / EDO);
}

// 例: 164 → "C4", 177 → "vE4"。vC は次の octave の C の直下なので octave は C 基準で数える
export function edo41NoteName(step: number): string {
  const degree = edo41Degree(step);
  const octave = edo41Octave(step) + (degree === EDO - 1 ? 1 : 0);
  return `${DEGREE_NAMES[degree]}${octave}`;
}
