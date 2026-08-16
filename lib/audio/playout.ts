/**
 * How much audio is still scheduled to play.
 *
 * Split from the player so it can be tested without an AudioContext. The
 * bridge waits on this before hanging up: the gateway closes two seconds after
 * the model stops *generating*, but the player schedules ahead, so terminating
 * SIP on the socket close alone cuts the agent off mid-goodbye.
 */
export function remainingPlayoutMs(nextStartTime: number, currentTime: number): number {
  return Math.max(0, Math.round((nextStartTime - currentTime) * 1000));
}
