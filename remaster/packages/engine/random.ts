import { World } from '../domain/types';
export function hashSeed(text: string): number { let hash = 2166136261; for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return hash >>> 0; }
export function random(world: World, stream: string): number {
  let state = world.random[stream] ?? hashSeed(`${world.seed}:${stream}`);
  state = (state + 0x6D2B79F5) >>> 0; world.random[stream] = state;
  let result = Math.imul(state ^ (state >>> 15), state | 1);
  result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
  return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
}
export function normal(world: World, stream: string): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, random(world, stream)))) * Math.cos(2 * Math.PI * random(world, stream));
}
