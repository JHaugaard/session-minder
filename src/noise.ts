// src/noise.ts
// Thresholds are a deliberately conservative starting point (spec: Open
// Question #3 — tune empirically once real Hermes capture data exists).
const NOISE_DURATION_SECONDS = 60;
const NOISE_MESSAGE_COUNT = 3;

// Duration is the primary signal: no platform's end-hook payload reliably
// carries a message count, so a null messageCount must not veto the flag
// (spec: "very short duration and/or very low message count") — otherwise
// the Hermes timeout/cron sessions this feature exists for never get flagged.
export function isNoise(input: {
  durationSeconds: number | null;
  messageCount: number | null;
}): boolean {
  if (input.durationSeconds === null) return false;
  if (input.durationSeconds >= NOISE_DURATION_SECONDS) return false;
  return input.messageCount === null || input.messageCount < NOISE_MESSAGE_COUNT;
}
