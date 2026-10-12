import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  allocateAwardAmounts,
  isProtocolErrorCode,
  printTokenId,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_FREEZE_ID,
  PUBLIC_SERIES_ID,
  PROPOSED_PUBLIC_SERIES_CAP,
} from "./index.ts";

function readFixture(relativePath: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${relativePath}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

test("protocol freeze id is stable", () => {
  assert.equal(PROTOCOL_FREEZE_ID, "mpoo-protocol-r0-2026-10-12");
});

test("error codes are unique uppercase identifiers", () => {
  const set = new Set(PROTOCOL_ERROR_CODES);
  assert.equal(set.size, PROTOCOL_ERROR_CODES.length);
  for (const code of PROTOCOL_ERROR_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/);
    assert.equal(isProtocolErrorCode(code), true);
  }
  assert.equal(isProtocolErrorCode("not-a-code"), false);
});

test("pressure fixture matches documented prototype defaults", () => {
  const config = readFixture("board/pressure-config.v1.json") as {
    baseCost: string;
    maxCost: string;
    heatCap: string;
    heatIncrement: string;
    decayPerSecond: string;
    surchargeNumerator: string;
    surchargeDenominator: string;
    quoteTtlNs: string;
    regionSize: number;
  };
  assert.equal(config.regionSize, 8);
  assert.equal(config.baseCost, "10");
  assert.equal(config.maxCost, "50");
  assert.equal(config.heatCap, "400");
  assert.equal(config.heatIncrement, "10");
  assert.equal(config.decayPerSecond, "1");
  assert.equal(config.surchargeNumerator, "1");
  assert.equal(config.surchargeDenominator, "10");
  assert.equal(config.quoteTtlNs, "30000000000");
});

test("expired quote fixture uses QUOTE_EXPIRED", () => {
  const fixture = readFixture("board/draw-rejected-expired-quote.json") as {
    error: { code: string };
    chargedCost: null;
    heatUnchanged: boolean;
  };
  assert.equal(fixture.error.code, "QUOTE_EXPIRED");
  assert.equal(isProtocolErrorCode(fixture.error.code), true);
  assert.equal(fixture.chargedCost, null);
  assert.equal(fixture.heatUnchanged, true);
});

test("funded vs draft bounty fixtures disagree on fundedAtNs", () => {
  const funded = readFixture("bounties/funded-active.json") as {
    bounty: { status: string; fundedAtNs: string | null };
    demoLabel: string;
  };
  const draft = readFixture("bounties/draft-unfunded.json") as {
    bounty: { status: string; fundedAtNs: string | null };
  };
  assert.equal(funded.bounty.status, "ACTIVE");
  assert.ok(funded.bounty.fundedAtNs);
  assert.equal(draft.bounty.status, "DRAFT");
  assert.equal(draft.bounty.fundedAtNs, null);
  assert.match(funded.demoLabel, /Demo data/);
});

test("award dust allocation matches sorted-recipient rule", () => {
  const fixture = readFixture("bounties/split-allocation.json") as {
    awardAmount: string;
    recipients: { accountId: string; shareBps: number }[];
    expectedSortedAllocations: { accountId: string; amount: string }[];
  };
  const allocated = allocateAwardAmounts(
    BigInt(fixture.awardAmount),
    fixture.recipients,
  );
  assert.deepEqual(
    allocated.map((row) => ({
      accountId: row.accountId,
      amount: row.amount.toString(),
    })),
    fixture.expectedSortedAllocations,
  );
  const sum = allocated.reduce((total, row) => total + row.amount, 0n);
  assert.equal(sum, BigInt(fixture.awardAmount));
});

test("allocateAwardAmounts rejects bad splits", () => {
  assert.throws(() =>
    allocateAwardAmounts(100n, [{ accountId: "a", shareBps: 9999 }]),
  );
  assert.throws(() =>
    allocateAwardAmounts(100n, [
      { accountId: "a", shareBps: 5000 },
      { accountId: "a", shareBps: 5000 },
    ]),
  );
});

test("print token id and public series constants", () => {
  const prints = readFixture("prints/public-vs-bounty-series.json") as {
    printId: string;
    publicSeries: { seriesId: string; cap: number };
    tokenIdExample: string;
  };
  assert.equal(prints.publicSeries.seriesId, PUBLIC_SERIES_ID);
  assert.equal(prints.publicSeries.cap, PROPOSED_PUBLIC_SERIES_CAP);
  assert.equal(
    printTokenId(prints.printId, PUBLIC_SERIES_ID, 1),
    prints.tokenIdExample,
  );
});

test("uncertain paint operation must not instruct auto-resubmit", () => {
  const fixture = readFixture("operations/uncertain-paint.json") as {
    operation: { status: string; lastErrorCode: string };
    rule: string;
  };
  assert.equal(fixture.operation.status, "confirmation_delayed");
  assert.equal(fixture.operation.lastErrorCode, "OPERATION_UNCERTAIN");
  assert.match(fixture.rule, /Do not auto-resubmit/i);
});
