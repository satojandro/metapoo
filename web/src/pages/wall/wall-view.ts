import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import type { ParsedRoute } from "../../app/routes";
import type { CachedPixel } from "../../board-cache";
import { formatFreshness, type BoardSyncState } from "../../board-sync";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import { isContractConfigured } from "../../contract";
import type { Cell } from "../../selection";
import type { SponsorshipStatus } from "../../sponsorship";
import { paintZoomCamera, PAINT_CELL_PX, type Camera, type ViewportSize } from "../../viewport";
import type { WallHint } from "../../wall-hint";
import { parseWallLinkSearch } from "./wall-link";
import type { WallScope } from "./wall-scope";

/** High-level UI phase for the status strip. */
export type UiPhase =
  | "disconnected"
  | "connected"
  | "editing"
  | "wallet_prompt"
  | "submitted"
  | "confirmed"
  | "confirmation_delayed"
  | "overwritten"
  | "failed";

export interface WallViewDeps {
  scope: WallScope;
  pageRoot: HTMLElement;
  selectionSummary: HTMLElement;
  preview: HTMLElement;
  palette: HTMLElement;
  rules: HTMLElement;
  lede: HTMLElement;
  sponsorNote: HTMLElement;
  drawState: HTMLElement;
  boardLoadStatus: HTMLElement;
  focusCanvas: HTMLButtonElement;
  /** Shell-owned status strip. */
  flowState: HTMLElement;
  compactStatus: HTMLElement;
  sponsorship: SponsorshipStatus;
  route: ParsedRoute | null | undefined;
  wallHint: Pick<WallHint, "selectionSucceeded">;
  render(): void;
  positionSelection(): void;
  applyCamera(next: Camera): void;
  readViewportSize(): ViewportSize;
  cellSize(): number;
  requestCellPrice(cell: Cell): void;
  cachedPixel(cell: Cell): CachedPixel | undefined;
  refreshSelectedPixel(): void;
  pendingCount(): number;
  boardSync(): Readonly<BoardSyncState>;
}

export interface WallView {
  selected(): Cell | null;
  /** Set the selection without any side effect (a paint in flight). */
  setSelected(cell: Cell | null): void;
  /** A user picked `cell`: dismiss the hint and move the flow to editing. */
  select(cell: Cell | null): void;
  selectedColor(): number | null;
  uiPhase(): UiPhase;
  setFlow(phase: UiPhase): void;
  showSelection(): void;
  updatePreview(): void;
  updateCompactStatus(): void;
  fillRules(): void;
  buildPalette(): void;
  applyRoutePaintingContext(): void;
}

/**
 * Status text, the selection panel, the palette and the rules. Owns what the
 * user has picked (square and colour) and the flow phase.
 */
export function createWallView(deps: WallViewDeps): WallView {
  const {
    scope,
    pageRoot,
    selectionSummary,
    preview,
    palette,
    rules,
    lede,
    sponsorNote,
    drawState,
    boardLoadStatus,
    focusCanvas,
    flowState,
    compactStatus,
    sponsorship,
    wallHint,
  } = deps;

  let selected: Cell | null = null;
  let selectedColor: number | null = null;
  let uiPhase: UiPhase = "disconnected";

  // Enlarge the real canvas without altering its pixels or wallet state.
  scope.listen(focusCanvas, "click", () => {
    const focused = pageRoot.querySelector(".wall-layout")!.classList.toggle("is-focused");
    focusCanvas.setAttribute("aria-pressed", String(focused));
    focusCanvas.textContent = focused ? "Back to the stall ↙" : "Focus canvas ↗";
  });

  sponsorNote.textContent = sponsorship.message;

  lede.textContent = isContractConfigured()
    ? "A live communal pixel wall on NEAR. Explore freely. Drawing asks your wallet to approve one on-chain paint."
    : "Preview mode · Explore the wall. Blockchain painting is not connected yet.";

  /**
   * Apply a `/wall?x=…&y=…&zoom=…` location link after the wall mounts.
   * Coordinates and zoom are clamped; a URL never supplies a trusted price.
   */
  function applyRoutePaintingContext(): void {
    if (scope.isDisposed() || !deps.route) {
      return;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(deps.route.query)) {
      if (value !== undefined && value !== "") {
        params.set(key, value);
      }
    }
    const parsed = parseWallLinkSearch(`?${params.toString()}`);
    if (parsed.x === null || parsed.y === null) {
      return;
    }

    selected = { x: parsed.x, y: parsed.y };
    wallHint.selectionSucceeded();
    const cellPx = parsed.zoom ?? PAINT_CELL_PX;
    deps.applyCamera(paintZoomCamera(deps.readViewportSize(), selected, cellPx));

    const contextBits: string[] = [
      `Focused square x=${parsed.x}, y=${parsed.y} from the link.`,
    ];
    if (parsed.board && CONTRACT_ID && parsed.board !== CONTRACT_ID) {
      contextBits.push(
        `Link board "${parsed.board}" differs from configured contract ${CONTRACT_ID}; coordinates were still applied.`,
      );
    }
    boardLoadStatus.textContent = contextBits.join(" ");
    if (scope.walletAccount()) {
      setFlow("editing");
    }
    showSelection();
    deps.render();
    deps.refreshSelectedPixel();
  }

  function showSelection(): void {
    const colorLabel =
      selectedColor === null ? "none yet" : `${colorName(selectedColor)} (index ${selectedColor})`;

    updatePreview();
    deps.positionSelection();

    if (!selected) {
      selectionSummary.textContent = `No square selected. Chosen paint: ${colorLabel}. Unpainted squares have no artist.`;
      return;
    }
    // Touch has no hover. Selecting a square is how a finger reads the price.
    deps.requestCellPrice(selected);

    const cached = deps.cachedPixel(selected);
    let cellText: string;
    if (!cached || cached.colorIndex === null) {
      cellText = isContractConfigured()
        ? "This square has no confirmed paint in our cache (unpainted or not read yet)."
        : "This square is unpainted on the local mock board.";
    } else {
      const paintedName = colorName(cached.colorIndex);
      const artist = cached.artistAccountId ?? "unknown account";
      cellText = `On-chain credit: ${paintedName} (index ${cached.colorIndex}) by ${artist}. Credit is the latest writer, not legal ownership.`;
    }

    selectionSummary.textContent = `Selected square x=${selected.x}, y=${selected.y}. Chosen paint: ${colorLabel}. Counting starts at the top-left. ${cellText}`;
  }

  function updatePreview(): void {
    preview.replaceChildren();
    const label = document.createElement("span");
    label.className = "preview-label";

    if (selectedColor === null) {
      label.textContent = "Paint preview: pick a named color.";
      preview.append(label);
      return;
    }

    const swatch = PALETTE.find((item) => item.index === selectedColor);
    if (!swatch) {
      label.textContent = "Paint preview: invalid color.";
      preview.append(label);
      return;
    }

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = swatch.hex;
    chip.setAttribute("aria-hidden", "true");
    label.textContent = `Paint preview: ${swatch.name} (palette index ${swatch.index})`;
    preview.append(chip, label);
  }

  function updateCompactStatus(): void {
    const network = isContractConfigured() ? PAGE_NETWORK : "mock";
    const walletAccount = scope.walletAccount();
    const account = walletAccount ? walletAccount : "not connected";
    const zoom = `~${deps.cellSize().toFixed(1)} px/cell`;
    const pendingCount = deps.pendingCount();
    const pendingLabel =
      pendingCount > 0 ? ` · ${pendingCount} pending` : "";
    const boardSync = deps.boardSync();
    const fresh =
      boardSync.lastAppliedAtMs === null
        ? ""
        : ` · ${formatFreshness(boardSync, Date.now()).replace(/^Board freshness: /, "")}`;
    compactStatus.textContent = `${network} · ${account} · ${zoom}${pendingLabel}${fresh} · no app fee`;
  }

  function fillRules(): void {
    const lines = [
      `The board is ${BOARD_WIDTH} by ${BOARD_HEIGHT} squares.`,
      "Square (0, 0) is the top-left. x counts to the right. y counts downward.",
      "An unpainted square is not a color. It has no stored artist. Palette index 0 is Ink, a real paint color.",
      "Overwrite rule: Open wall. Any connected account may paint any pixel, including one someone else painted. Vandalism is possible.",
      "The current artist is credit for the latest successful write. That is not a legal claim on the artwork.",
      "Explore with pan and zoom. Place paint (or Enter) submits a draw. With Direct paint enabled at paint zoom, drag to paint a stroke. Pan and pinch never paint.",
      isContractConfigured()
        ? `Game contract: ${CONTRACT_ID} on ${PAGE_NETWORK}. On open (and Refresh), the page loads every painted cell via paginated get_pixels. Transaction execution is reported separately from the latest cell owner; a successful paint may already be overwritten under Open wall.`
        : "No game contract id is configured yet (VITE_CONTRACT_ID empty), so this page will not open a draw signature or claim a chain success.",
      sponsorship.flagEnabled
        ? "Sponsorship flag is on, but the submit path stays ordinary wallet until a sponsor service exists."
        : "Sponsorship is off. No cross-chain or paid checkout is offered on this page.",
    ];
    const list = document.createElement("ul");
    for (const line of lines) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    rules.replaceChildren(list);
  }

  function buildPalette(): void {
    for (const swatch of PALETTE) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "swatch";
      button.setAttribute("aria-pressed", "false");
      button.setAttribute(
        "aria-label",
        `${swatch.name}, palette index ${swatch.index}, color ${swatch.hex}`,
      );
      button.setAttribute("aria-describedby", "selection-summary");
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.background = swatch.hex;
      chip.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = `${swatch.name} (${swatch.index})`;
      button.append(chip, label);
      button.addEventListener("click", () => {
        selectedColor = swatch.index;
        for (const other of palette.querySelectorAll("button")) {
          other.setAttribute("aria-pressed", other === button ? "true" : "false");
        }
        if (scope.walletAccount() && selected) {
          setFlow("editing");
        }
        deps.render();
        showSelection();
      });
      palette.append(button);
    }
  }

  function setFlow(phase: UiPhase): void {
    uiPhase = phase;
    const labels: Record<UiPhase, string> = {
      disconnected: "State: disconnected — look freely; draw needs a wallet.",
      connected: "State: connected — pick a square and a named color.",
      editing: "State: editing — review the pixel rule, then Place paint.",
      wallet_prompt: "State: wallet prompt — approve or reject in your wallet.",
      submitted: "State: submitted — transaction is in flight; awaiting confirmation.",
      confirmed: "State: confirmed — the transaction executed and the confirming read matched.",
      confirmation_delayed: "State: confirmation delayed — outcome is unresolved and will not be resubmitted automatically.",
      overwritten: "State: overwritten — the transaction executed, then another artist became the current cell owner.",
      failed: "State: failed — the transaction did not execute; you can review and try again.",
    };
    flowState.textContent = labels[phase];
    flowState.dataset.phase = phase;
    // Keep the current transaction outcome adjacent to the action that caused it;
    // shell chrome remains a compact duplicate for navigation-wide visibility.
    drawState.textContent = labels[phase].replace(/^State: /, "");
    drawState.dataset.phase = phase;
  }

  return {
    selected: () => selected,
    setSelected(cell) {
      selected = cell;
    },
    select(cell) {
      selected = cell;
      wallHint.selectionSucceeded();
      if (scope.walletAccount()) {
        setFlow("editing");
      }
    },
    selectedColor: () => selectedColor,
    uiPhase: () => uiPhase,
    setFlow,
    showSelection,
    updatePreview,
    updateCompactStatus,
    fillRules,
    buildPalette,
    applyRoutePaintingContext,
  };
}

/** textContent only. Account ids and error strings must not be inserted as HTML. */
export function fillBlock(host: HTMLElement, title: string, message: string): void {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  host.append(heading, paragraph);
}

export function fillResultWithLink(
  result: HTMLElement,
  title: string,
  message: string,
  transactionId: string | null,
  explorer: string | null,
): void {
  result.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  result.append(heading, paragraph);
  if (transactionId) {
    const idLine = document.createElement("p");
    idLine.textContent = `Transaction id: ${transactionId}`;
    result.append(idLine);
  }
  if (explorer) {
    const link = document.createElement("a");
    link.href = explorer;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open transaction in explorer";
    result.append(link);
  }
}

export function clearBlock(host: HTMLElement): void {
  host.replaceChildren();
}

export function colorName(index: number): string {
  return PALETTE.find((swatch) => swatch.index === index)?.name ?? `index ${index}`;
}
