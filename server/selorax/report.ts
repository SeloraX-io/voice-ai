/**
 * Fires a Selorax inbound-call report without making the caller wait for it.
 *
 * `POST /api/telephony/report` is called at the instant the bridge answers
 * or declines a ringing phone. Correlation bookkeeping is the least
 * important thing happening in that moment, and it must not sit in front of
 * a caller — `createCallingClient`'s requests carry a 10-second timeout, so
 * awaiting this before responding could hold a live call's response open for
 * up to 10 seconds whenever Selorax is slow or unreachable.
 *
 * `dispatchReport` is deliberately synchronous (not `async`): it starts the
 * upstream call and returns immediately, so nothing about its own signature
 * can tempt a caller into awaiting it. The failure handler is attached at
 * the same expression that creates the promise, not after — an unattached
 * rejection becomes an unhandled one, which on Node can bring the whole
 * process down, trading a delay for a crash.
 *
 * Safe only because the route this backs sets `runtime = "nodejs"`: a
 * long-lived process where detached work genuinely completes. The same
 * pattern on a serverless/edge runtime could have its process frozen or torn
 * down before the promise settles, and would need a different approach
 * (e.g. `waitUntil`).
 */

import type { CallingClient } from "./calling-client";

export type ReportEvent = "answered" | "declined";

export function dispatchReport(
  client: CallingClient,
  event: ReportEvent,
  callerPhone: string,
  onError: (cause: unknown) => void,
): void {
  const promise =
    event === "answered" ? client.reportAnswered(callerPhone) : client.reportDeclined(callerPhone);
  void promise.catch(onError);
}
