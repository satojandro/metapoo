import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { explorerUrl, isInsideBoard, reasonDrawIsBlocked, validateSession } from "./board-rules.ts";
import { PALETTE } from "./palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type WalletSession } from "./types.ts";

const connectedMock: WalletSession = {
  connected: true,
  accountId: "learner",
  networkId: "mock",
};

test("board.json matches the TypeScript board size and palette", () => {
  const path = fileURLToPath(new URL("./board.json", import.meta.url));
  const board = JSON.parse(readFileSync(path, "utf8"));

  assert.equal(board.schema_version, 0);
  assert.equal(board.width, BOARD_WIDTH);
  assert.equal(board.height, BOARD_HEIGHT);
  assert.equal(board.origin, "top-left");
  assert.equal(board.overwrite_rule, "unresolved");
  assert.equal(board.sponsorship_enabled, false);
  assert.equal(board.palette.length, PALETTE.length);

  for (let index = 0; index < PALETTE.length; index += 1) {
    assert.equal(board.palette[index].index, PALETTE[index].index);
    assert.equal(board.palette[index].name, PALETTE[index].name);
    assert.equal(board.palette[index].hex, PALETTE[index].hex);
  }
});

test("column 0 and row 0 are on the wall", () => {
  assert.equal(isInsideBoard(0, 0), true);
});

test("column 128 is off the wall", () => {
  assert.equal(isInsideBoard(128, 0), false);
});

test("fractional pixels are rejected", () => {
  assert.equal(isInsideBoard(1.5, 2), false);
});

test("a bad column is reported before the ownership rule", () => {
  const error = reasonDrawIsBlocked(
    { x: 200, y: 1, colorIndex: 0 },
    connectedMock,
    "mock",
    "unresolved",
  );
  assert.equal(error?.code, "COORDINATE_OUT_OF_RANGE");
});

test("a bad color is rejected", () => {
  const error = reasonDrawIsBlocked(
    { x: 1, y: 1, colorIndex: 8 },
    connectedMock,
    "mock",
    "unresolved",
  );
  assert.equal(error?.code, "COLOR_OUT_OF_RANGE");
});

test("a valid pixel still cannot be drawn while the rule is unresolved", () => {
  const error = reasonDrawIsBlocked(
    { x: 3, y: 4, colorIndex: 2 },
    connectedMock,
    "mock",
    "unresolved",
  );
  assert.equal(error?.code, "OWNERSHIP_RULE_UNRESOLVED");
  assert.match(error?.message ?? "", /no transaction was sent/i);
});

test("a disconnected session is its own error", () => {
  const error = validateSession(
    { connected: false, accountId: null, networkId: "mock" },
    "mock",
  );
  assert.equal(error?.code, "WALLET_NOT_CONNECTED");
});

test("a pretend testnet session does not match the mock board", () => {
  const error = validateSession(
    { connected: true, accountId: "learner", networkId: "testnet" },
    "mock",
  );
  assert.equal(error?.code, "NETWORK_MISMATCH");
});

test("mock mode has no explorer link, even with an id", () => {
  assert.equal(explorerUrl("mock", "abc"), null);
  assert.equal(explorerUrl("testnet", null), null);
});

test("a testnet id can be shown in an explorer url", () => {
  assert.equal(
    explorerUrl("testnet", "abc"),
    "https://testnet.nearblocks.io/txns/abc",
  );
});
