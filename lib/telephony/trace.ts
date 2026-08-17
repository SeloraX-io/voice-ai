/**
 * Call-lifecycle tracing for the softphone bridge.
 *
 * The bridge spans four components — Asterisk, JsSIP, the audio graph and the
 * voice gateway — and until this existed a call that failed to connect left no
 * evidence anywhere. "The phone rang and the AI never picked up" has at least
 * five distinct causes (no INVITE arrived, the INVITE was refused, the gateway
 * would not open, `answer()` threw, media never flowed) and no way to tell them
 * apart after the fact.
 *
 * Always on, deliberately. These events fire once per call, not per packet, so
 * the volume is a handful of lines per call — and the one call you need them
 * for is the one that already happened. For the full SIP message dump, which is
 * far too noisy to leave on, enable JsSIP's own tracing from the console:
 *
 *     localStorage.debug = "JsSIP:*"   // then reload
 *
 * Never pass a SIP password, an auth token or call audio through here.
 */

const PREFIX = "[bridge]";

export function trace(event: string, detail?: Record<string, unknown>): void {
  if (detail === undefined) {
    console.info(`${PREFIX} ${event}`);
    return;
  }
  console.info(`${PREFIX} ${event}`, detail);
}

/** A cause worth printing, from a JsSIP event that may carry anything. */
export function causeOf(value: unknown): string {
  if (value === null || value === undefined) return "none";
  return typeof value === "string" ? value : String(value);
}
