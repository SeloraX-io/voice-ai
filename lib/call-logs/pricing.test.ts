import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_USAGE } from "./types";
import {
  BDT_PER_USD,
  computeCost,
  DEFAULT_RATES,
  formatBdt,
  ratesFor,
  usageFromReport,
  usdToBdt,
} from "./pricing";

test("costs nothing when nothing was used", () => {
  assert.deepEqual(computeCost(EMPTY_USAGE, DEFAULT_RATES["gemini-3.1-flash-live-preview"]), {
    inputUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
  });
});

test("prices each modality at its own rate", () => {
  // Exactly 1M of each, so the cost equals the per-million rate.
  const cost = computeCost(
    {
      inputTextTokens: 1_000_000,
      inputAudioTokens: 1_000_000,
      outputTextTokens: 1_000_000,
      outputAudioTokens: 1_000_000,
      reports: 1,
    },
    DEFAULT_RATES["gemini-3.1-flash-live-preview"],
  );

  assert.equal(cost.inputUsd, 0.75 + 3.0);
  assert.equal(cost.outputUsd, 4.5 + 12.0);
  assert.equal(cost.totalUsd, 20.25);
});

test("totals the two halves", () => {
  const cost = computeCost(
    { ...EMPTY_USAGE, inputAudioTokens: 500_000, outputAudioTokens: 250_000, reports: 1 },
    DEFAULT_RATES["gemini-3.1-flash-live-preview"],
  );
  assert.equal(cost.inputUsd, 1.5);
  assert.equal(cost.outputUsd, 3.0);
  assert.equal(cost.totalUsd, 4.5);
});

test("falls back to the live model's rates for an unknown model", () => {
  const rates = ratesFor("some-model-we-have-never-seen");
  assert.deepEqual(rates, DEFAULT_RATES["gemini-3.1-flash-live-preview"]);
});

test("uses the exact rates when the model is known", () => {
  assert.equal(ratesFor("gemini-3.1-flash-live-preview").outputAudioPerMillion, 12.0);
});

test("reads a usage report, splitting tokens by modality", () => {
  const usage = usageFromReport(
    {
      promptTokensDetails: [
        { modality: "AUDIO", tokenCount: 1500 },
        { modality: "TEXT", tokenCount: 400 },
      ],
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 900 }],
    },
    EMPTY_USAGE,
  );

  assert.equal(usage.inputAudioTokens, 1500);
  assert.equal(usage.inputTextTokens, 400);
  assert.equal(usage.outputAudioTokens, 900);
  assert.equal(usage.outputTextTokens, 0);
  assert.equal(usage.reports, 1);
});

test("treats reports as cumulative totals, not deltas", () => {
  // Two reports for one call. The second is the running total, so the result
  // must be the second reading — not the sum, which would double-bill.
  const first = usageFromReport(
    { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1000 }] },
    EMPTY_USAGE,
  );
  const second = usageFromReport(
    { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 2500 }] },
    first,
  );

  assert.equal(second.inputAudioTokens, 2500);
  assert.equal(second.reports, 2);
});

test("keeps the larger reading if a report arrives out of order", () => {
  // Defensive: a late or duplicated frame must never reduce a total, or the
  // final cost would depend on delivery order.
  const first = usageFromReport(
    { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 2500 }] },
    EMPTY_USAGE,
  );
  const stale = usageFromReport(
    { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1000 }] },
    first,
  );

  assert.equal(stale.inputAudioTokens, 2500);
});

test("treats an unspecified modality as text, as the API documents", () => {
  const usage = usageFromReport(
    { promptTokensDetails: [{ modality: "MODALITY_UNSPECIFIED", tokenCount: 120 }] },
    EMPTY_USAGE,
  );
  assert.equal(usage.inputTextTokens, 120);
});

test("survives a report with no detail breakdown", () => {
  const usage = usageFromReport({}, EMPTY_USAGE);
  assert.deepEqual(usage, { ...EMPTY_USAGE, reports: 1 });
});

test("ignores a modality it does not price, rather than miscounting it", () => {
  const usage = usageFromReport(
    { promptTokensDetails: [{ modality: "IMAGE", tokenCount: 999 }] },
    EMPTY_USAGE,
  );
  assert.equal(usage.inputTextTokens, 0);
  assert.equal(usage.inputAudioTokens, 0);
});

test("converts dollars to taka at the published rate", () => {
  assert.equal(usdToBdt(1), BDT_PER_USD);
  assert.equal(usdToBdt(0.15), 0.15 * BDT_PER_USD);
});

test("formats taka, keeping digits for amounts under one taka", () => {
  assert.equal(formatBdt(0), "৳0.00");
  assert.equal(formatBdt(0.15), "৳19.50");
  // A short call: fractions of a taka must not round away to nothing.
  assert.equal(formatBdt(0.00005), "৳0.0065");
});

test("stores dollars and converts only for display", () => {
  // The guard against baking a rate into history: the same stored figure must
  // re-read at whatever rate is current, so conversion stays a pure function
  // of the USD amount rather than something written into a record.
  const storedUsd = 0.00691125;
  assert.equal(usdToBdt(storedUsd), storedUsd * BDT_PER_USD);
});
