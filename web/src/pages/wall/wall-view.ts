import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH } from "@shared/types.ts";
import type { ParsedRoute } from "../../app/routes";
import type { CachedPixel } from "../../board-cache";
import { formatFreshness, type BoardSyncState } from "../../board-sync";
import { CONTRACT_ID, PAGE_NETWORK } from "../../config";
import { isContractConfigured } from "../../contract";
import { boardPalette } from "../../contract-meta";
import type { Cell } from "../../selection";
import type { SponsorshipStatus } from "../../sponsorship";
import { paintZoomCamera, PAINT_CELL_PX, type Camera, type ViewportSize } from "../../viewport";
import type { WallHint } from "../../wall-hint";
import { parseWallLinkSearch } from "./wall-link";
import type { WallScope } from "./wall-scope";

/** Colours every deployed board accepts; shown until `get_board` reports its own. */
export const DEFAULT_PALETTE_LENGTH = 8;

/** Swatches per row when the dock wraps (two rows of 8 on a phone). */
const SWATCHES_PER_ROW = 8;

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
  /** Called after the selection text changes, so Place paint can follow it. */
  onSelectionShown?(): void;
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
  /** Build (or reconcile) the swatches for the board's palette. Safe to call again. */
  buildPalette(): void;
  /**
   * The board reported how many colours it accepts (8 or 16). The dock shows exactly
   * those; a chosen colour the board would reject resets to 0 (Ink).
   */
  setPaletteLength(paletteLength: number): void;
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
    flowState,
    compactStatus,
    sponsorship,
    wallHint,
  } = deps;

  let selected: Cell | null = null;
  let selectedColor: number | null = null;
  let uiPhase: UiPhase = "disconnected";
  // Until get_board answers, offer only the colours every deployed board accepts.
  // Today's boards reject 8–15 with ColorOutOfRange.
  let paletteLength = DEFAULT_PALETTE_LENGTH;
  let paletteBuilt = false;

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
    updatePreview();
    deps.positionSelection();

    if (!selected) {
      setSummary("No square selected. ", "Tap a square on the wall to choose it.");
      deps.onSelectionShown?.();
      return;
    }
    // Touch has no hover. Selecting a square is how a finger reads the price.
    deps.requestCellPrice(selected);

    const cached = deps.cachedPixel(selected);
    let cellText: string;
    if (!cached || cached.colorIndex === null) {
      cellText = isContractConfigured()
        ? "Square chosen. Nobody has painted it yet."
        : "Square chosen. Empty on the preview board.";
    } else {
      const paintedName = colorName(cached.colorIndex);
      const artist = cached.artistAccountId ?? "unknown account";
      cellText = `Square chosen. Painted ${paintedName} by ${artist}.`;
    }

    setSummary(`Selected square x=${selected.x}, y=${selected.y}. `, cellText);
    deps.onSelectionShown?.();
  }

  /**
   * Visible text stays plain. Coordinates go to screen readers only: arrow-key
   * users need them, and the toolbar readout shows them to everyone who looks.
   */
  function setSummary(spoken: string, shown: string): void {
    const hidden = document.createElement("span");
    hidden.className = "visually-hidden";
    hidden.textContent = spoken;
    selectionSummary.replaceChildren(hidden, document.createTextNode(shown));
  }

  function updatePreview(): void {
    preview.replaceChildren();
    const label = document.createElement("span");
    label.className = "preview-label";

    if (selectedColor === null) {
      label.textContent = "Pick a colour.";
      preview.append(label);
      return;
    }

    const swatch = PALETTE.find((item) => item.index === selectedColor);
    if (!swatch) {
      label.textContent = "That colour isn't on this wall. Pick another.";
      preview.append(label);
      return;
    }

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = swatch.hex;
    chip.setAttribute("aria-hidden", "true");
    label.textContent = `Your colour: ${swatch.name}`;
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
      "Look mode: drag to move the wall, tap to see a tile. Paint mode: tap a square, then Paint this tile (or Enter). With a drawing key, drag paints a stroke. Moving and pinching never paint.",
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

  function swatchButtons(): HTMLButtonElement[] {
    return [...palette.querySelectorAll<HTMLButtonElement>(".swatch")];
  }

  /** Mark the chosen swatch pressed and give it the group's single tab stop. */
  function syncSwatches(): void {
    const buttons = swatchButtons();
    const pressedIndex = buttons.findIndex((b) => Number(b.dataset.index) === selectedColor);
    buttons.forEach((button, i) => {
      button.setAttribute("aria-pressed", i === pressedIndex ? "true" : "false");
      button.tabIndex = i === (pressedIndex === -1 ? 0 : pressedIndex) ? 0 : -1;
    });
  }

  function createSwatch(swatch: { index: number; name: string; hex: string }): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.dataset.index = String(swatch.index);
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
      syncSwatches();
      if (scope.walletAccount() && selected) {
        setFlow("editing");
      }
      deps.render();
      showSelection();
    });
    return button;
  }

  /**
   * Reconcile the dock with the board's palette. Swatches 0–7 are never replaced,
   * so a reference to one stays valid when a 16-colour board adds 8–15.
   */
  function buildPalette(): void {
    paletteBuilt = true;
    const wanted = boardPalette(paletteLength);
    const existing = swatchButtons();
    for (const button of existing.slice(wanted.length)) {
      button.remove();
    }
    for (const swatch of wanted.slice(existing.length)) {
      palette.append(createSwatch(swatch));
    }
    palette.dataset.count = String(wanted.length);
    syncSwatches();
  }

  function setPaletteLength(next: number): void {
    const length = boardPalette(next).length;
    if (length === paletteLength && paletteBuilt) {
      return;
    }
    paletteLength = length;
    const reset = selectedColor !== null && selectedColor >= paletteLength;
    if (reset) {
      selectedColor = 0;
    }
    if (paletteBuilt) {
      buildPalette();
    }
    if (reset) {
      deps.render();
      showSelection();
    }
  }

  /**
   * Swatches per visual row. Two rows of 8 on a phone, one row of 16 where it fits:
   * read it from layout. Without layout (tests, a detached dock) assume rows of 8.
   */
  function swatchesPerRow(buttons: HTMLButtonElement[]): number {
    const first = buttons[0]?.getBoundingClientRect();
    if (!first || first.width === 0) {
      return Math.min(buttons.length, SWATCHES_PER_ROW);
    }
    let count = 1;
    while (
      count < buttons.length &&
      Math.abs(buttons[count]!.getBoundingClientRect().top - first.top) < 1
    ) {
      count += 1;
    }
    return count;
  }

  // Arrow keys move focus through the swatches (ARIA toolbar pattern): left/right
  // wrap across the row break, up/down jump a row when there are two.
  scope.listen(palette, "keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    const buttons = swatchButtons();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) {
      return;
    }
    const perRow = swatchesPerRow(buttons);
    let next: number;
    switch (key) {
      case "ArrowRight":
        next = (current + 1) % buttons.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + buttons.length) % buttons.length;
        break;
      case "ArrowDown":
        next = current + perRow < buttons.length ? current + perRow : current;
        break;
      case "ArrowUp":
        next = current - perRow >= 0 ? current - perRow : current;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons.forEach((button, i) => {
      button.tabIndex = i === next ? 0 : -1;
    });
    buttons[next]!.focus();
  });

  function setFlow(phase: UiPhase): void {
    uiPhase = phase;
    const labels: Record<UiPhase, string> = {
      disconnected: "Look around freely. Connect a wallet to paint.",
      connected: "Choose a square, then a colour.",
      editing: "Choose a colour, then Paint this tile.",
      wallet_prompt: "Approve or reject in your wallet.",
      submitted: "Sent. Waiting for the wall to confirm.",
      confirmed: "Painted. Your square is on the wall.",
      confirmation_delayed: "Still waiting for confirmation. It won't be sent again automatically.",
      overwritten: "Painted, then someone painted over it.",
      failed: "That didn't go through. You can try again.",
    };
    flowState.textContent = labels[phase];
    flowState.dataset.phase = phase;
    // Keep the current transaction outcome adjacent to the action that caused it;
    // shell chrome remains a compact duplicate for navigation-wide visibility.
    drawState.textContent = labels[phase];
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
    setPaletteLength,
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
