# Selorax-Backed Bridge — Design

**Goal:** make the AI softphone bridge a client of the **SeloraX-Backend calling
API** instead of a thing configured with hand-pasted SIP credentials — so it
gets its line, its TURN servers and its call correlation the same way the
dashboard's human agents do, using the endpoints that already exist.

**Builds on:** `2026-08-16-ai-softphone-bridge-design.md`, which is implemented
and reviewed. This changes where the bridge gets its configuration and what it
reports back. It does not change how audio flows.

---

## 1. The constraint, stated once

SIP signalling and WebRTC media flow **browser ↔ Asterisk, directly**.
SeloraX-Backend was never in that path: it issues credentials and does
bookkeeping, then steps aside. It is an Express app with no RTP stack, so
routing audio through it would mean building a media server inside the API
server — strictly worse than the `externalMedia` design already set aside.

So the backend becomes the **control plane**. The media plane is unchanged.
Everything below follows from that split.

---

## 2. Why this is worth doing now

Three reasons, in the order they matter.

**The bridge currently has no ICE configuration.** `lib/telephony/sip-bridge.ts`
sets no `pcConfig`, so JsSIP falls back to a single public STUN server. That is
the exact failure the dashboard already diagnosed and fixed — STUN-only ICE
fails behind symmetric NAT and restrictive firewalls, producing one-way or
missing call audio (`SeloraX-Backend/routers/calling.js:317-330`, and the
dashboard's own `docs/plans/2026-07-30-calling-audio-fix.md`). `GET
/api/calling/extension` returns short-lived TURN credentials alongside the SIP
line. **This is a correctness fix, not a convenience.** If the first live call
has bad audio, this is the first thing to suspect.

**Calls currently do not correlate.** selx-sip's inbound webhook never says
which extension answered — its `extension` field is always null for inbound
(`routers/calling.js:1162`). The dashboard compensates by self-reporting via
`POST /api/calling/inbound-answered`. The AI does not, so its calls sit outside
Selorax's call log, credit accounting and order correlation.

**Credentials stop being a manual artefact.** No pasting, no copy from
devtools, no stale password after a rotation.

---

## 3. Architecture

```
browser bridge page
   │  (never sees a Selorax credential)
   ▼
voice-ai Next server ── x-auth-token ──► SeloraX-Backend /api/calling/*
   │                                            │
   │  SIP line + iceServers                     │ existing endpoints,
   ▼                                            │ unchanged
browser ──── JsSIP / WebRTC ────► Asterisk ◄────┘
```

**The Next server holds the Selorax token; the browser never does.** This is
deliberate and is the one structural decision in this document. A Selorax admin
token is a powerful credential, and the bridge is a web page — putting it in
the browser would repeat the `NEXT_PUBLIC_VOICE_GATEWAY_KEY` compromise we
accepted under duress elsewhere. Here there is no reason to accept it: the page
only needs the SIP line, so only the SIP line reaches it.

The SIP password still reaches the browser. That is unavoidable — digest auth
happens in the page — and it is exactly what the dashboard already does with
the same secret.

---

## 4. No backend changes

Every endpoint the bridge needs already exists and is used by the dashboard:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/calling/extension` | GET | SIP line (`ws_url`, `sip_uri`, `sip_domain`, `extension`, `password`) **plus `iceServers`**. Claims the device. |
| `/api/calling/extension/status` | GET | Read-only "is there a usable extension here" — no device claim, no side effects. |
| `/api/calling/inbound-answered` | POST | `{caller_phone}` → correlates the call to this user. |
| `/api/calling/inbound-declined` | POST | `{caller_phone}` → the reject path. |

All four are `[auth, admin]` and read `req.user.user_id` / `req.user.store_id`
from the JWT. Nothing new is added to SeloraX-Backend.

---

## 5. Identity and authentication

**A dedicated Selorax admin user for the AI**, with its own extension. This was
already required by the previous design — `claimCallingDevice` evicts whichever
device registered last, so an AI sharing a human's extension means the two
evict each other on every call. Now it also carries the AI's identity in the
call log.

**Give that user a restricted role.** The token is a normal admin JWT with
whatever the user can do, and Selorax has a roles system
(`middlewares/hasPermission.js`, `routers/roles.js`). The AI needs calling only.
This is the difference between a leaked token costing you phone calls and
costing you your order book.

**Token acquisition is manual, once per 90 days.** Admin login is OTP-based, so
a headless client cannot self-authenticate. An operator logs into the dashboard
as the AI user, copies the `x-auth-token` cookie, and pastes it into voice-ai's
settings once. `models/user.js:263` signs these for **90 days**.

This is a deliberate trade: one pasted value that expires quarterly, versus a
new backend authentication surface. If that proves annoying, the follow-up is a
service-token endpoint on SeloraX-Backend — but that is new backend surface,
and this design's entire point is to need none.

**Device identity.** `GET /api/calling/extension` claims the device from the
`x-device-id` header. The bridge must send a **stable** id (`ai-bridge-<storeId>`)
so a restart does not look like a new device and churn the claim. Because the
AI has its own user, its claim can never evict a human agent.

---

## 6. What changes in voice-ai

**6.1 Configuration.** `data/telephony.json` stops holding five SIP values and
starts holding the Selorax connection:

```ts
interface SeloraxConfig {
  baseUrl: string;    // https://api.selorax.io
  authToken: string;  // the AI user's x-auth-token
  storeId: string;    // sent as x-store-id
}
```

The device id is derived (`ai-bridge-${storeId}`), not configured — a value
with one correct answer should not be a field someone can get wrong.

**6.2 A server-only Selorax client.** `server/selorax/calling-client.ts`, never
imported into a client component. Sends `x-auth-token`, `x-store-id` and
`x-device-id`; maps failures to intelligible errors rather than propagating raw
status codes. A `401` means the token expired and must say so in those words —
"Unauthorized" ninety days later is a support ticket.

**6.3 Three proxy routes**, mirroring the existing `app/api/telephony/route.ts`
conventions (`runtime = "nodejs"`, `dynamic = "force-dynamic"`):

- `GET /api/telephony/line` → the SIP line and `iceServers`. **Never returns
  the Selorax token.**
- `POST /api/telephony/answered` → `{caller_phone}`
- `POST /api/telephony/declined` → `{caller_phone}`

The last two are fire-and-forget from the bridge's point of view: correlation
bookkeeping must never delay answering a ringing phone, and a reporting failure
must never drop a call.

**6.4 The bridge fetches instead of reading pasted values.** On **Go online**,
`GET /api/telephony/line`, then register with what comes back. On an inbound
call, answer first and report `answered` after — in that order. On a call the
bridge cannot take, report `declined`.

**6.5 ICE finally gets configured.** Pass the returned `iceServers` into JsSIP
as `pcConfig`, exactly as `CallContext.js:594` does. When the call is a
best-effort TURN failure, fall back to the current behaviour rather than
refusing to register — the dashboard treats TURN as non-blocking for the same
reason.

**6.6 The direct-credentials path stays, demoted.** Selorax mode is the
default. Direct mode remains for developing without a backend, labelled as
such. Deleting it would make voice-ai untestable in isolation, which is a
worse outcome than one extra branch.

---

## 7. Failure modes

| Failure | Behaviour |
|---|---|
| Token expired (401) | Registration refused with "The Selorax token has expired — paste a fresh one." Not a generic auth error. |
| Selorax unreachable on Go online | Do not register. An agent that is online without a line is a phone that rings into nothing. |
| Selorax unreachable mid-call | Nothing. The call is already peer-to-peer; only correlation is lost, and that is logged, not fatal. |
| `answered` report fails | Log it, keep the call. The caller is talking to the agent; bookkeeping can be reconciled later. |
| No extension provisioned for the AI user | `extension_not_active` → say plainly that the AI user needs an extension in Selorax. |
| TURN credentials missing | Register anyway with STUN only, and warn. Matches the dashboard's non-blocking treatment. |
| Device claim evicted | Surface it. If it happens, the dedicated-user rule was broken. |

---

## 8. Testing

Pure and testable, therefore tested: the Selorax config validator, the client's
header construction and error mapping (including 401 → expired-token), and the
proxy routes' contract that no route response can contain the token — asserted
directly, because that is the one mistake with a real cost.

Verified by hand on a live call: TURN actually being used (check the
`RTCPeerConnection` selects a relay candidate on a restrictive network), and
the call appearing in Selorax's call log against the AI user.

The Selorax client must be tested against a stub, never a live backend. Nothing
in this repo's test suite may write into a real Selorax store.

---

## 9. Risks

- **A 90-day manual token is a rotation people forget.** Mitigation: the
  settings screen shows expiry decoded from the JWT, and warns before it lapses.
  It is still a chore; the honest fix is a service-token endpoint later.
- **An admin JWT is broad.** Mitigated by a restricted role on the AI user, not
  by the design. If the roles system cannot constrain it to calling, say so
  before shipping rather than after.
- **`GET /api/calling/extension` is rate-limited to 5/min per user.** A crash
  loop on Go online could trip it. Fetch once per online session, not per call.
- **This spec assumes the base bridge works.** If the first live call reveals a
  fundamental audio problem, some of §6 may be redesigned — though §2's ICE
  finding means this work may itself be the fix.

---

## 10. Milestones

1. **Selorax config and client.** Validator, store, server-only client, proxy
   routes. Testable without a browser.
2. **The bridge uses it.** Fetch on Go online, `pcConfig` from `iceServers`,
   settings form replaced. → **TURN is live; the audio path is properly
   configured for the first time.**
3. **Correlation.** `answered` / `declined` reporting, so the AI's calls appear
   in Selorax alongside human ones.

1 is a prerequisite for 2. 3 is independent and can follow the first call.
