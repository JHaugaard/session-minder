// test/noise.test.ts
import { describe, it, expect } from 'vitest';
import { isNoise } from '../src/noise.js';

describe('isNoise', () => {
  it('flags a session with under 60 seconds duration and under 3 messages', () => {
    expect(isNoise({ durationSeconds: 10, messageCount: 1 })).toBe(true);
  });

  it('flags a short session with unknown message count (Hermes timeout/cron case)', () => {
    expect(isNoise({ durationSeconds: 5, messageCount: null })).toBe(true);
  });

  it('does not flag a short session with real message traffic', () => {
    expect(isNoise({ durationSeconds: 30, messageCount: 20 })).toBe(false);
  });

  it('does not flag a normal working session', () => {
    expect(isNoise({ durationSeconds: 900, messageCount: 40 })).toBe(false);
  });

  it('does not flag when duration is unknown (session still open)', () => {
    expect(isNoise({ durationSeconds: null, messageCount: null })).toBe(false);
  });

  it('does not flag at exactly the duration threshold (60s is not short)', () => {
    expect(isNoise({ durationSeconds: 60, messageCount: 0 })).toBe(false);
  });

  it('does not flag at exactly the message-count threshold (3 is not "very low")', () => {
    expect(isNoise({ durationSeconds: 59, messageCount: 3 })).toBe(false);
  });

  it('flags just inside both thresholds (59s and 2 messages)', () => {
    expect(isNoise({ durationSeconds: 59, messageCount: 2 })).toBe(true);
  });
});
