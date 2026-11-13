// Seeded, serialisable RNG (sfc32). The state lives inside the world so that
// snapshot + same operations => identical future.
import type { World } from './types';

export function seedRng(seed: number): number[] {
  const s = [seed >>> 0, (seed * 2654435761) >>> 0, 0x9e3779b9, 1];
  const w = { rng: s } as World;
  for (let i = 0; i < 20; i++) rand(w);
  return s;
}

export function rand(w: World): number {
  const s = w.rng;
  let a = s[0] | 0, b = s[1] | 0, c = s[2] | 0, d = s[3] | 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
  return (t >>> 0) / 4294967296;
}
export const randInt = (w: World, lo: number, hi: number) => lo + Math.floor(rand(w) * (hi - lo + 1));
export const chance = (w: World, p: number) => rand(w) < p;
export const pick = <T>(w: World, arr: readonly T[]): T => arr[Math.floor(rand(w) * arr.length)];
export function gauss(w: World, mean = 0, sd = 1): number {
  const u = Math.max(rand(w), 1e-12), v = rand(w);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function weighted<T>(w: World, items: readonly T[], weights: readonly number[]): T {
  let tot = 0;
  for (const x of weights) tot += x;
  let r = rand(w) * tot;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}
export function shuffle<T>(w: World, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand(w) * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}
