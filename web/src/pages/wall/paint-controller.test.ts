/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import { createDrawRequest } from "../../draw-request";
import { makeAuthorizedSessionRecord, saveDrawingSessionRecord } from "../../drawing-session";
import type { Cell } from "../../selection";
import { createPaintController } from "./paint-controller";
import type { CreditReservation, PaidQuote } from "./pricing-controller";
import type { UiPhase } from "./wall-view";
import { createWallScope } from "./wall-scope";

vi.mock("../../submit-draw", () => ({ submitDraw: vi.fn() }));
vi.mock("../../local-draw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../local-draw")>();
  return {
    ...actual,
    canUseLocalDrawingSession: vi.fn(() => true),
    fetchDrawingSessionAllowance: vi.fn(async () => ({ found: true, remainingYocto: null, permissionSummary: "" })),
    // Signing reads must never really hit the network in unit tests.
    prefetchSigningContext: vi.fn(() => new Promise(() => undefined)),
    signAndSendStrokeLocally: vi.fn(async () => ({
      status: "confirmed", confirmedChunks: 1, totalChunks: 1, outcomes: [], failingChunk: null,
      executedBlocks: [],
      chunks: [{ index: 0, state: "confirmed", message: null, transactionHash: "tx", blockHeight: null }],
    })),
  };
});
vi.mock("../../config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config")>();
  return { ...actual, CONTRACT_ID: "board.paint.testnet", PAGE_NETWORK: "testnet" };
});
vi.mock("../../contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract")>();
  return { ...actual, isContractConfigured: () => true };
});
import { submitDraw } from "../../submit-draw";
import { canUseLocalDrawingSession, prefetchSigningContext, signAndSendStrokeLocally } from "../../local-draw";

type DrawResult = Awaited<ReturnType<typeof submitDraw>>;
const confirmed = (x: number, y: number, colorIndex: number): DrawResult => ({
  status: "confirmed",
  title: "Paint confirmed",
  message: "ok",
  transactionId: `tx-${x}-${y}`,
  explorerUrl: null,
  pixel: { x, y, colorIndex, artistAccountId: "alice.testnet", lastWriteTimestampNs: "1" },
  observedBlockHeight: 3,
});

function setup(options: { metaOk?: boolean } = {}) {
  document.body.innerHTML = `
    <div id="viewport"></div><button id="draw"></button><div id="result"></div><p id="draw-state"></p><p id="flow"></p>
    <label><input type="checkbox" id="toggle"></label><p id="tap-status"></p>
    <div id="unlock"></div><p id="unlocked"></p><button id="unlock-btn"></button>
    <div id="renew" hidden></div><button id="renew-btn"></button>
    <button id="auth"></button><button id="forget"></button><button id="revoke"></button>
    <p id="session-status"></p><p id="session-note"></p>
  `;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const scope = createWallScope();
  scope.setWallet("alice.testnet", "testnet");
  const services = createAppServices();
  let selected: Cell | null = null;
  let selectedColor: number | null = 2;
  let phase: UiPhase = "disconnected";
  const board = {
    contractMetaOk: () => options.metaOk ?? true,
    contractMetaIssue: () => ({ kind: "read" as const, detail: "offline" }),
    rememberPixel: vi.fn(),
    refreshBoardFromContract: vi.fn(async () => undefined),
  };
  const pricing = {
    paidBoard: vi.fn(() => false),
    priceUnavailable: vi.fn(() => false),
    allowGestureRetry: vi.fn(),
    ensurePaidQuote: vi.fn(async (
      _cells: Cell[], _accountId: string | null, _options?: { reservation?: CreditReservation | null },
    ): Promise<PaidQuote | null> => ({
      maxCredits: null, chunkMaxCredits: null, reservation: null,
    })),
    admitTap: vi.fn((): CreditReservation | null => ({ id: 0 })),
    settle: vi.fn(),
    release: vi.fn(),
    confirmRequote: vi.fn(async (): Promise<number | null> => null),
    refreshCreditsDock: vi.fn(async () => undefined),
    repriceCell: vi.fn(),
  };
  const view = {
    selected: () => selected,
    setSelected: (cell: Cell | null) => { selected = cell; },
    selectedColor: () => selectedColor,
    setFlow: vi.fn((next: UiPhase) => { phase = next; }),
    showSelection: vi.fn(),
  };
  const toggle = el<HTMLInputElement>("toggle");
  const paint = createPaintController({
    scope,
    services,
    sponsorship: { flagEnabled: false, message: "No sponsor." } as never,
    boardViewport: el("viewport"),
    drawState: el("draw-state"),
    flowState: el("flow"),
    drawButton: el<HTMLButtonElement>("draw"),
    result: el("result"),
    directPaintToggle: toggle,
    tapToPaintAffordance: toggle.closest("label")!,
    tapToPaintAnnouncement: el("tap-status"),
    paintUnlock: el("unlock"),
    paintUnlocked: el("unlocked"),
    unlockPaintButton: el<HTMLButtonElement>("unlock-btn"),
    paintRenew: el("renew"),
    renewPaintButton: el<HTMLButtonElement>("renew-btn"),
    authorizeSessionButton: el<HTMLButtonElement>("auth"),
    forgetSessionButton: el<HTMLButtonElement>("forget"),
    revokeSessionButton: el<HTMLButtonElement>("revoke"),
    drawingSessionStatus: el("session-status"),
    drawingSessionNote: el("session-note"),
    board,
    pricing,
    view,
    render: vi.fn(),
  });
  return {
    paint, scope, services, board, pricing, view, toggle,
    result: el("result"),
    drawButton: el<HTMLButtonElement>("draw"),
    select: (cell: Cell | null) => { selected = cell; },
    setColor: (c: number | null) => { selectedColor = c; },
    phase: () => phase,
    dispose: () => { paint.dispose(); scope.markDisposed(); scope.runCleanups(); },
  };
}

beforeEach(() => {
  vi.mocked(submitDraw).mockReset();
  vi.mocked(signAndSendStrokeLocally).mockClear();
  vi.mocked(prefetchSigningContext).mockClear();
  vi.mocked(canUseLocalDrawingSession).mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("paint controller", () => {
  it("attemptDraw with nothing selected explains and never submits", async () => {
    const t = setup();
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.result.querySelector("h3")?.textContent).toBeTruthy();
    expect(t.phase()).toBe("editing");
    t.dispose();
  });

  it("attemptDraw refuses while contract metadata is not valid", async () => {
    const t = setup({ metaOk: false });
    t.select({ x: 1, y: 1 });
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.phase()).toBe("failed");
    t.dispose();
  });

  it("a confirmed draw records the op, stamps the pixel, re-reads and re-prices", async () => {
    vi.mocked(submitDraw).mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.select({ x: 4, y: 5 });
    await t.paint.attemptDraw();
    expect(submitDraw).toHaveBeenCalledWith(expect.objectContaining({ x: 4, y: 5, colorIndex: 2, accountId: "alice.testnet" }));
    expect(t.services.operations.list()[0]).toMatchObject({
      kind: "paint", phase: "confirmed", transactionId: "tx-4-5", title: "Paint confirmed",
      meta: { x: 4, y: 5, colorIndex: 2 },
    });
    expect(t.board.rememberPixel).toHaveBeenCalledWith(confirmed(4, 5, 2).pixel, 3);
    expect(t.board.refreshBoardFromContract).toHaveBeenCalledWith({ reason: "after_draw" });
    expect(t.pricing.refreshCreditsDock).toHaveBeenCalled();
    expect(t.pricing.repriceCell).toHaveBeenCalledWith({ x: 4, y: 5 });
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.paint.drawInFlight()).toBe(false);
    t.dispose();
  });

  it("a refused price leaves no pending mark and no wallet prompt", async () => {
    const t = setup();
    t.pricing.ensurePaidQuote.mockResolvedValueOnce(null);
    t.select({ x: 4, y: 5 });
    await t.paint.attemptDraw();
    expect(submitDraw).not.toHaveBeenCalled();
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.services.operations.list()).toHaveLength(0);
    t.dispose();
  });

  type StrokeResult = Awaited<ReturnType<typeof signAndSendStrokeLocally>>;
  type ChunkState = "confirmed" | "failed" | "uncertain" | "not_sent";
  /** One batch's result, as the pipelined sender reports it. */
  const strokeOutcome = (state: ChunkState, tx: string | null, options: { height?: number | null; message?: string | null } = {}): StrokeResult => {
    const height = options.height ?? null;
    const chunk = { index: 0, state, message: options.message ?? null, transactionHash: tx, blockHeight: null };
    return {
      status: state === "confirmed" ? "confirmed" : "partial",
      confirmedChunks: state === "confirmed" ? 1 : 0, totalChunks: 1, outcomes: [], chunks: [chunk],
      failingChunk: state === "confirmed" ? null
        : { index: 0, mayHaveBroadcast: state === "uncertain", message: options.message ?? "" },
      // Deferred heights: the result returns on the receipt; the height follows.
      executedBlocks: [],
      executedBlocksLater: Promise.resolve(state === "confirmed" && height !== null ? [{ chunkIndex: 0, blockHeight: height }] : []),
    };
  };
  /** Hold the next session send open until the test releases it. */
  const holdNextSend = () => {
    let release!: (r: StrokeResult) => void;
    vi.mocked(signAndSendStrokeLocally).mockImplementationOnce(() => new Promise((r) => { release = r; }));
    return (r: StrokeResult) => release(r);
  };

  describe("when the chain refuses the drawing key for its allowance", () => {
    const refusal = "Access Key {account_id}:{public_key} does not have enough balance 0.0308734581660761 for transaction costing 0.0309213099526195";
    const refused = (): StrokeResult => ({
      status: "partial", confirmedChunks: 0, totalChunks: 1, outcomes: [], executedBlocks: [],
      failingChunk: { index: 0, mayHaveBroadcast: false, message: refusal },
      chunks: [{ index: 0, state: "failed", message: refusal, transactionHash: "tx-refused", blockHeight: null }],
    });
    const storeKey = (publicKey: string) => saveDrawingSessionRecord(makeAuthorizedSessionRecord({
      accountId: "alice.testnet", networkId: "testnet", contractId: "board.paint.testnet",
      publicKey, secretKey: "ed25519:fixture",
    }));
    const renewPrompt = () => document.getElementById("renew")!;

    beforeEach(() => {
      const stored = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("offers one approval in the dock, then clears the prompt once the new key is stored", async () => {
      storeKey("ed25519:spent");
      vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(refused());
      const t = setup();
      const authorize = vi.fn(async (_options?: { replacePublicKey?: string | null }) => {
        storeKey("ed25519:fresh");
        return { accountId: "alice.testnet", publicKey: "ed25519:fresh", transactionHash: "h", confirmed: true };
      });
      t.services.wallet.authorizeDrawingSession = authorize;
      t.paint.showDrawingSession();
      expect(renewPrompt().hidden).toBe(true);

      t.paint.maybeEnqueueDirectPaint({ x: 4, y: 5 });
      await vi.waitFor(() => expect(renewPrompt().hidden).toBe(false));
      expect(t.result.textContent).toContain("Your painting key is low");
      expect(t.result.textContent).not.toMatch(/account_id|public_key/);
      // Renewing is the painter's click: the refused paint is never resent.
      expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1);
      expect(authorize).not.toHaveBeenCalled();

      document.getElementById("renew-btn")!.click();
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
      expect(authorize).toHaveBeenCalledWith({ replacePublicKey: "ed25519:spent" });
      await vi.waitFor(() => expect(renewPrompt().hidden).toBe(true));
      expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1);
      t.dispose();
    });

    it("keeps the prompt when the painter closes the wallet window", async () => {
      storeKey("ed25519:spent");
      vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(refused());
      const t = setup();
      t.services.wallet.authorizeDrawingSession = vi.fn(async () => { throw new Error("User closed"); });
      t.paint.showDrawingSession();
      t.paint.maybeEnqueueDirectPaint({ x: 4, y: 5 });
      await vi.waitFor(() => expect(renewPrompt().hidden).toBe(false));
      document.getElementById("renew-btn")!.click();
      await vi.waitFor(() => expect(t.services.wallet.authorizeDrawingSession).toHaveBeenCalled());
      await vi.waitFor(() => expect(document.getElementById("renew-btn")).toHaveProperty("disabled", false));
      expect(renewPrompt().hidden).toBe(false);
      t.dispose();
    });

    it("does not offer a new key for any other failure", async () => {
      storeKey("ed25519:spent");
      const other = refused();
      other.chunks[0]!.message = "Sender alice.testnet does not have enough balance 1 for transaction costing 2";
      vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(other);
      const t = setup();
      t.paint.showDrawingSession();
      t.paint.maybeEnqueueDirectPaint({ x: 4, y: 5 });
      await vi.waitFor(() => expect(t.result.textContent).toContain("Sender alice.testnet"));
      expect(renewPrompt().hidden).toBe(true);
      t.dispose();
    });
  });

  it("a lone tap with a drawing session takes the pipelined path, not the single-draw path", async () => {
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(strokeOutcome("confirmed", "tx-lone", { height: 812 }));
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 4, y: 5 });
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    expect(submitDraw).not.toHaveBeenCalled();
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({
      cells: [{ x: 4, y: 5 }], color: 2, deferBlockHeights: true, prepared: expect.any(Promise),
    });
    // The signing reads started before the quote was asked for, so they overlap it.
    expect(vi.mocked(prefetchSigningContext).mock.invocationCallOrder[0])
      .toBeLessThan(t.pricing.ensurePaidQuote.mock.invocationCallOrder[0]!);
    // Settled on the receipt, stamped at the executed block, no confirming re-read.
    await vi.waitFor(() => expect(t.paint.pendingCount()).toBe(0));
    expect(t.board.rememberPixel).toHaveBeenCalledWith(expect.objectContaining({ x: 4, y: 5, colorIndex: 2 }), 812);
    expect(t.result.querySelector("h3")?.textContent).toBe("Pixel painted");
    expect(t.services.operations.list().find((op) => op.transactionId === "tx-lone")?.phase).toBe("confirmed");
    t.dispose();
  });

  it("each tap keeps one operation record from submitted to its outcome", async () => {
    // paintOperationId stamps the clock into the id. Recomputing it per phase left
    // a "submitted" record behind for every tap, listed as recoverable forever.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(signAndSendStrokeLocally).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return strokeOutcome("confirmed", "tx-one");
    });
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 6, y: 6 });
    await vi.waitFor(() => expect(t.result.querySelector("h3")?.textContent).toBe("Pixel painted"));
    expect(t.services.operations.list().filter((op) => op.kind === "paint")).toHaveLength(1);
    expect(t.services.operations.listRecoverable()).toEqual([]);
    vi.useRealTimers();
    t.dispose();
  });

  it("a confirmed tap keeps its marker until the stamp lands, and never clears a newer paint's marker", async () => {
    let heights!: (blocks: Array<{ chunkIndex: number; blockHeight: number }>) => void;
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce({
      ...strokeOutcome("confirmed", "tx-a"),
      executedBlocksLater: new Promise((r) => { heights = r; }),
    });
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    await vi.waitFor(() => expect(t.result.querySelector("h3")?.textContent).toBe("Pixel painted"));
    // Settled (the next paint may go), but the cell keeps its colour via the marker.
    expect(t.paint.drawInFlight()).toBe(false);
    expect(t.paint.pendingCount()).toBe(1);
    heights([{ chunkIndex: 0, blockHeight: 900 }]);
    await vi.waitFor(() => expect(t.paint.pendingCount()).toBe(0));
    expect(t.board.rememberPixel).toHaveBeenCalledWith(expect.objectContaining({ x: 1, y: 1 }), 900);
    t.dispose();
  });

  it("taps that queue behind an in-flight paint go out together as one draw_many", async () => {
    const release = holdNextSend();
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(strokeOutcome("confirmed", "tx-batch", { height: 900 }));
    const t = setup();
    t.paint.showDrawingSession();
    // The first tap is sent the moment it arrives, alone: no batching delay.
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    t.paint.maybeEnqueueDirectPaint({ x: 2, y: 2 });
    t.paint.maybeEnqueueDirectPaint({ x: 3, y: 3 });
    t.paint.maybeEnqueueDirectPaint({ x: 4, y: 4 });
    expect(t.paint.queueLength()).toBe(3);
    release(strokeOutcome("confirmed", "tx-first", { height: 899 }));
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(2));
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[1]![0]).toMatchObject({
      accountId: "alice.testnet", color: 2,
      cells: [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }],
    });
    await vi.waitFor(() => expect(t.paint.pendingCount()).toBe(0));
    expect(t.paint.queueLength()).toBe(0);
    expect(t.board.rememberPixel).toHaveBeenCalledWith(expect.objectContaining({ x: 3, y: 3, colorIndex: 2 }), 900);
    const ops = t.services.operations.list().filter((op) => op.transactionId === "tx-batch");
    expect(ops.map((op) => op.phase)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(t.result.querySelector("h3")?.textContent).toBe("Taps painted");
    t.dispose();
  });

  it("a batch only groups taps of the same colour, in order", async () => {
    const release = holdNextSend();
    vi.mocked(signAndSendStrokeLocally)
      .mockResolvedValueOnce(strokeOutcome("confirmed", "tx-pair"))
      .mockResolvedValueOnce(strokeOutcome("confirmed", "tx-five"));
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    t.paint.maybeEnqueueDirectPaint({ x: 2, y: 2 });
    t.paint.maybeEnqueueDirectPaint({ x: 3, y: 3 });
    t.setColor(5);
    t.paint.maybeEnqueueDirectPaint({ x: 4, y: 4 });
    release(strokeOutcome("confirmed", "tx-first"));
    // Colour 2 pair as one batch, then the colour-5 tap on its own.
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(signAndSendStrokeLocally).mock.calls.map(([a]) => a);
    expect(calls[1]).toMatchObject({ color: 2, cells: [{ x: 2, y: 2 }, { x: 3, y: 3 }] });
    expect(calls[2]).toMatchObject({ color: 5, cells: [{ x: 4, y: 4 }] });
    t.dispose();
  });

  it("a batch whose transaction may have landed keeps every tap pending, and never retries", async () => {
    const release = holdNextSend();
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(strokeOutcome("uncertain", "tx-lost", { message: "lost response" }));
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    t.paint.maybeEnqueueDirectPaint({ x: 2, y: 2 });
    t.paint.maybeEnqueueDirectPaint({ x: 3, y: 3 });
    release(strokeOutcome("confirmed", "tx-first"));
    await vi.waitFor(() => expect(t.result.textContent).toContain("Taps may have been sent"));
    expect(t.paint.pendingCount()).toBe(2);
    expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(2);
    expect(t.pricing.settle).toHaveBeenCalled();
    t.dispose();
  });

  it("a batch that was never broadcast clears its marks and gives the credits back", async () => {
    const release = holdNextSend();
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce(strokeOutcome("not_sent", null, { message: "signer exploded" }));
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    t.pricing.admitTap.mockReturnValueOnce({ id: 7 }).mockReturnValueOnce({ id: 8 });
    t.paint.maybeEnqueueDirectPaint({ x: 2, y: 2 });
    t.paint.maybeEnqueueDirectPaint({ x: 3, y: 3 });
    t.pricing.ensurePaidQuote.mockImplementationOnce(async (_cells, _account, options) => ({
      maxCredits: 2, chunkMaxCredits: [2], reservation: options?.reservation ?? null,
    }));
    release(strokeOutcome("confirmed", "tx-first"));
    await vi.waitFor(() => expect(t.result.textContent).toContain("Taps not painted"));
    await vi.waitFor(() => expect(t.paint.pendingCount()).toBe(0));
    // The second tap's hold is returned up front; the first one carries the batch.
    expect(t.pricing.ensurePaidQuote).toHaveBeenLastCalledWith(
      [{ x: 2, y: 2 }, { x: 3, y: 3 }], "alice.testnet", expect.objectContaining({ reservation: { id: 7 } }));
    expect(t.pricing.release).toHaveBeenCalledWith({ id: 8 });
    expect(t.pricing.release).toHaveBeenCalledWith({ id: 7 });
    expect(t.pricing.settle).not.toHaveBeenCalledWith({ id: 7 });
    t.dispose();
  });

  it("without a drawing session, taps stay one wallet paint per approval", async () => {
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
    let release!: (r: DrawResult) => void;
    vi.mocked(submitDraw)
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockImplementation(async (input) => confirmed(input.x, input.y, input.colorIndex));
    const t = setup();
    t.paint.enqueueUnsent(createDrawRequest({ x: 1, y: 1, colorIndex: 2, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.enqueueUnsent(createDrawRequest({ x: 2, y: 2, colorIndex: 2, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.enqueueUnsent(createDrawRequest({ x: 3, y: 3, colorIndex: 2, accountId: "alice.testnet", networkId: "testnet" }));
    void t.paint.drainPaintQueue();
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(1));
    expect(t.paint.queueLength()).toBe(2);
    release(confirmed(1, 1, 2));
    await vi.waitFor(() => expect(submitDraw).toHaveBeenCalledTimes(3));
    expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    t.dispose();
  });

  it("a tap pricing refuses is not queued", () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.pricing.admitTap.mockReturnValueOnce(null);
    t.paint.maybeEnqueueDirectPaint({ x: 1, y: 1 });
    expect(t.paint.queueLength()).toBe(0);
    expect(t.paint.pendingCount()).toBe(0);
    t.dispose();
  });

  it("onWalletChanged drops unsent paints and says so", () => {
    const t = setup();
    t.paint.enqueueUnsent(createDrawRequest({ x: 1, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.enqueueUnsent(createDrawRequest({ x: 2, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.onWalletChanged();
    expect(t.paint.queueLength()).toBe(0);
    expect(t.paint.pendingCount()).toBe(0);
    expect(t.result.querySelector("h3")?.textContent).toBe("Queued paints cancelled");
    t.dispose();
  });

  it("an armed drag becomes one stroke; a blocked one names the reason", async () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    expect(t.paint.strokes.active()).toBe(true);
    t.paint.strokes.extend({ x: 2, y: 1 });
    expect(t.paint.overlayPixels()).toHaveLength(2);
    t.paint.strokes.finish({ x: 3, y: 1 }, "drag", vi.fn());
    expect(t.paint.strokes.active()).toBe(false);
    await vi.waitFor(() => expect(signAndSendStrokeLocally).toHaveBeenCalledTimes(1));
    expect(vi.mocked(signAndSendStrokeLocally).mock.calls[0]![0]).toMatchObject({
      cells: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }], color: 2,
    });
    await vi.waitFor(() => expect(t.result.querySelector("h3")?.textContent).toBe("Stroke confirmed"));

    t.setColor(null);
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    expect(t.paint.strokes.active()).toBe(false);
    expect(document.getElementById("draw-state")!.textContent).not.toBe("");
    t.dispose();
  });

  it("a stroke with a gap in the middle resolves each batch on its own", async () => {
    // Pipelined batches: batch 2 failing (price rose) does not stop batch 3.
    const chunk = (index: number, state: "confirmed" | "failed" | "uncertain" | "not_sent", message: string | null = null) =>
      ({ index, state, message, transactionHash: state === "not_sent" ? null : `tx${index}`, blockHeight: state === "confirmed" ? 50 + index : null });
    vi.mocked(signAndSendStrokeLocally).mockResolvedValueOnce({
      status: "partial", confirmedChunks: 1, totalChunks: 3, outcomes: [],
      chunks: [chunk(0, "uncertain", "lost"), chunk(1, "failed", "Smart contract panicked: PriceRoseAboveMax"), chunk(2, "confirmed")],
      failingChunk: { index: 0, mayHaveBroadcast: true, message: "lost" },
      executedBlocks: [{ chunkIndex: 2, blockHeight: 52 }],
    });
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 0, y: 0 }, false);
    // Three batches: the line back across row 1 adds its cells too.
    t.paint.strokes.extend({ x: 127, y: 0 });
    t.paint.strokes.extend({ x: 0, y: 1 });
    t.paint.strokes.finish({ x: 1, y: 1 }, "drag", vi.fn());
    await vi.waitFor(() => expect(t.result.querySelector("h3")?.textContent).toBe("Stroke stopped"));
    const sent = vi.mocked(signAndSendStrokeLocally).mock.calls.at(-1)![0].cells;
    expect(sent.length).toBeGreaterThan(128);
    expect(sent.length).toBeLessThanOrEqual(192);
    // Only the uncertain batch stays pending; the confirmed tail is stamped at its block.
    expect(t.paint.pendingCount()).toBe(64);
    expect(t.board.rememberPixel).toHaveBeenCalledWith(expect.objectContaining(sent[128]!), 52);
    // The re-quote covers exactly the batch that was refused, not the confirmed tail.
    expect(t.pricing.confirmRequote).toHaveBeenCalledWith(sent.slice(64, 128), "alice.testnet");
    expect(t.result.textContent).toContain("Batch 2 was not painted.");
    t.dispose();
  });

  it("a one-cell tap stroke selects instead of committing", () => {
    const t = setup();
    t.paint.showDrawingSession();
    t.paint.strokes.begin({ x: 1, y: 1 }, false);
    const selectHere = vi.fn();
    t.paint.strokes.finish(null, "tap", selectHere);
    expect(selectHere).toHaveBeenCalled();
    expect(signAndSendStrokeLocally).not.toHaveBeenCalled();
    t.dispose();
  });

  it("Place paint is disabled by a latched price failure on a paid board", () => {
    const t = setup();
    t.select({ x: 1, y: 1 });
    t.pricing.paidBoard.mockReturnValue(true);
    t.pricing.priceUnavailable.mockReturnValue(true);
    t.paint.syncSubmitEnabled();
    expect(t.drawButton.disabled).toBe(true);
    t.pricing.priceUnavailable.mockReturnValue(false);
    t.paint.syncSubmitEnabled();
    expect(t.drawButton.disabled).toBe(false);
    t.dispose();
  });

  it("Direct paint follows the session and an explicit opt-out sticks", () => {
    const t = setup();
    t.paint.showDrawingSession();
    expect(t.toggle.checked).toBe(true);
    expect(t.drawButton.hidden).toBe(true);
    t.toggle.checked = false;
    t.toggle.dispatchEvent(new Event("change"));
    t.paint.updateDirectPaintAvailability();
    expect(t.toggle.checked).toBe(false);
    expect(t.drawButton.hidden).toBe(false);
    vi.mocked(canUseLocalDrawingSession).mockReturnValue(false);
    t.paint.updateDirectPaintAvailability();
    expect(document.getElementById("unlock")!.hidden).toBe(false);
    t.dispose();
  });

  it("dispose drops unsent paints quietly", () => {
    const t = setup();
    t.paint.enqueueUnsent(createDrawRequest({ x: 1, y: 0, colorIndex: 1, accountId: "alice.testnet", networkId: "testnet" }));
    t.paint.dispose();
    expect(t.paint.queueLength()).toBe(0);
    expect(t.result.textContent).toBe("");
  });
});
