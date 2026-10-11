import "./style.css";
import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type NetworkId } from "@shared/types.ts";
import {
  createPixelCache,
  getCachedPixel,
  paintedPixels,
  rememberPixel,
} from "./board-cache";
import { CONTRACT_ID, PAGE_NETWORK } from "./config";
import { getBoard, getPixel, isContractConfigured } from "./contract";
import { prepareDraw } from "./draw-policy";
import { describeNetwork } from "./network";
import { renderBoard } from "./render-board";
import { cellFromOffset, moveSelection, type Cell } from "./selection";
import { describeSponsorship } from "./sponsorship";
import { submitDraw } from "./submit-draw";
import { connectWallet, disconnectWallet, onWalletSession } from "./wallet";

/**
 * Page wiring.
 *
 * State flow (also documented in web/README.md):
 * disconnected → connected → editing → wallet prompt → pending → success | error
 *
 * The picture only changes after a confirmed chain read, never on click alone.
 */

function mustFind<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`The page is missing required element ${selector}.`);
  }
  return element;
}

const canvas = mustFind<HTMLCanvasElement>("#board");
const selectionRing = mustFind<HTMLElement>("#selection-ring");
const boardFocus = mustFind<HTMLElement>("#board-focus");
const selectionSummary = mustFind<HTMLElement>("#selection-summary");
const preview = mustFind<HTMLElement>("#selection-preview");
const palette = mustFind<HTMLElement>("#palette");
const drawButton = mustFind<HTMLButtonElement>("#draw-button");
const result = mustFind<HTMLElement>("#result");
const rules = mustFind<HTMLElement>("#rules");
const walletSummary = mustFind<HTMLElement>("#wallet-summary");
const networkSummary = mustFind<HTMLElement>("#network-summary");
const connectButton = mustFind<HTMLButtonElement>("#connect-button");
const walletError = mustFind<HTMLElement>("#wallet-error");
const sponsorNote = mustFind<HTMLElement>("#sponsor-note");
const evidence = mustFind<HTMLElement>("#evidence");
const flowState = mustFind<HTMLElement>("#flow-state");
const lede = mustFind<HTMLElement>("#lede");

const pixelCache = createPixelCache();

let selected: Cell | null = null;
let selectedColor: number | null = null;
let walletAccount: string | null = null;
let walletNetwork: string | null = null;
let drawInFlight = false;
/** High-level UI phase for the status strip. */
let uiPhase:
  | "disconnected"
  | "connected"
  | "editing"
  | "wallet_prompt"
  | "pending"
  | "success"
  | "error" = "disconnected";

const sponsorship = describeSponsorship();
sponsorNote.textContent = sponsorship.message;

lede.textContent = isContractConfigured()
  ? "A shared pixel wall on NEAR. You can look without a wallet. Drawing asks your wallet to approve one on-chain paint."
  : "A shared pixel wall. You can look without a wallet. Drawing stays blocked until a game contract id is configured.";

fillRules();
buildPalette();
setFlow("disconnected");
render();
showSelection();
showWallet();
void bootstrapBoard();

drawButton.addEventListener("click", () => {
  void attemptDraw();
});

connectButton.addEventListener("click", () => {
  void onConnectClick();
});

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const next = cellFromOffset(
    event.clientX - rect.left,
    event.clientY - rect.top,
    rect.width,
    rect.height,
  );
  if (!next) {
    return;
  }
  selected = next;
  if (walletAccount) {
    setFlow("editing");
  }
  render();
  showSelection();
  boardFocus.focus();
  void refreshSelectedPixel();
});

boardFocus.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void attemptDraw();
    return;
  }
  const next = moveSelection(selected, event.key);
  if (next === selected) {
    return;
  }
  if (
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "ArrowLeft" ||
    event.key === "ArrowRight"
  ) {
    event.preventDefault();
    selected = next;
    if (walletAccount) {
      setFlow("editing");
    }
    render();
    showSelection();
    void refreshSelectedPixel();
  }
});

onWalletSession((session) => {
  walletAccount = session.accountId;
  walletNetwork = session.networkId;
  if (!walletAccount) {
    setFlow("disconnected");
  } else if (uiPhase === "disconnected" || uiPhase === "error") {
    setFlow(selected ? "editing" : "connected");
  }
  showWallet();
});

async function bootstrapBoard(): Promise<void> {
  if (!isContractConfigured()) {
    evidence.textContent =
      "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state. Set VITE_CONTRACT_ID to read a real contract.";
    return;
  }

  evidence.textContent = `Evidence: reading contract ${CONTRACT_ID} on ${PAGE_NETWORK} via ${"RPC"}. Painted cells appear only after a successful get_pixel read — not when you click.`;
  try {
    const board = await getBoard();
    evidence.textContent = `Evidence: contract ${CONTRACT_ID} on ${PAGE_NETWORK}. Board ${board.width}×${board.height}, rule ${board.overwrite_rule}, sponsorship_enabled=${board.sponsorship_enabled}. Sparse cells load when you select them or after a confirmed draw.`;
    if (board.sponsorship_enabled && !sponsorship.flagEnabled) {
      // Contract claimed sponsorship; page flag still controls what we advertise.
      sponsorNote.textContent = `${sponsorship.message} (Contract reported sponsorship_enabled=true; this page still does not offer a sponsored submit path.)`;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown read error";
    evidence.textContent = `Evidence: contract id is set (${CONTRACT_ID}), but get_board failed: ${detail}. You can still look at the local empty picture.`;
  }
}

async function refreshSelectedPixel(): Promise<void> {
  if (!selected || !isContractConfigured()) {
    showSelection();
    return;
  }
  try {
    const pixel = await getPixel(selected.x, selected.y);
    rememberPixel(pixelCache, pixel);
    render();
    showSelection();
  } catch {
    // Keep the last cached view; selection text still works offline.
    showSelection();
  }
}

async function attemptDraw(): Promise<void> {
  if (drawInFlight) {
    return;
  }

  const decision = prepareDraw({
    x: selected?.x ?? null,
    y: selected?.y ?? null,
    color: selectedColor,
    connected: walletAccount !== null,
    accountId: walletAccount,
    sessionNetworkId: walletNetworkId(),
    boardNetworkId: PAGE_NETWORK,
    contractId: CONTRACT_ID,
  });

  if (decision.outcome === "blocked") {
    setFlow(walletAccount ? "editing" : "disconnected");
    fillBlock(result, decision.title, decision.message);
    return;
  }

  if (!selected || selectedColor === null || !walletAccount) {
    return;
  }

  drawInFlight = true;
  drawButton.disabled = true;
  setFlow("wallet_prompt");
  fillBlock(
    result,
    "Waiting for your wallet",
    [
      `Approve draw at x=${selected.x}, y=${selected.y}, color=${selectedColor} (${colorName(selectedColor)}).`,
      "Your wallet may ask you to pay a small network gas fee. The game adds no application fee.",
      sponsorship.message,
    ].join(" "),
  );

  try {
    const submitResult = await submitDraw({
      x: selected.x,
      y: selected.y,
      colorIndex: selectedColor,
      accountId: walletAccount,
      networkId: walletNetworkId(),
      onProgress: (progress) => {
        if (progress.phase === "wallet_prompt") {
          setFlow("wallet_prompt");
          fillBlock(result, "Waiting for your wallet", progress.detail);
        } else if (progress.phase === "pending" || progress.phase === "confirming") {
          setFlow("pending");
          fillResultWithLink(
            "Transaction pending",
            progress.phase === "pending"
              ? "The wallet returned a transaction id. Confirming against a fresh board read…"
              : "Re-reading the pixel from the contract before we claim success…",
            progress.transactionId,
            progress.explorer,
          );
        }
      },
    });

    if (submitResult.status === "success" && submitResult.pixel) {
      rememberPixel(pixelCache, submitResult.pixel);
      render();
      setFlow("success");
      fillResultWithLink(
        submitResult.title,
        submitResult.message,
        submitResult.transactionId,
        submitResult.explorerUrl,
      );
      showSelection();
      return;
    }

    setFlow("error");
    fillResultWithLink(
      submitResult.title,
      submitResult.message,
      submitResult.transactionId,
      submitResult.explorerUrl,
    );
  } finally {
    drawInFlight = false;
    drawButton.disabled = false;
    showWallet();
  }
}

async function onConnectClick(): Promise<void> {
  clearBlock(walletError);
  connectButton.disabled = true;
  try {
    if (walletAccount) {
      await disconnectWallet();
      setFlow("disconnected");
    } else {
      await connectWallet();
      setFlow(selected ? "editing" : "connected");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
    setFlow("error");
    fillBlock(
      walletError,
      "Wallet was not connected",
      `You can keep looking at the board. ${detail}`,
    );
  } finally {
    connectButton.disabled = false;
    showWallet();
  }
}

function render(): void {
  renderBoard(canvas, paintedPixels(pixelCache));
  if (!selected) {
    selectionRing.hidden = true;
    return;
  }
  const widthPercent = 100 / BOARD_WIDTH;
  const heightPercent = 100 / BOARD_HEIGHT;
  selectionRing.hidden = false;
  selectionRing.style.left = `${selected.x * widthPercent}%`;
  selectionRing.style.top = `${selected.y * heightPercent}%`;
  selectionRing.style.width = `${widthPercent}%`;
  selectionRing.style.height = `${heightPercent}%`;
  // Preview outline uses a second border color when a palette color is chosen,
  // so selection is not color-only (ring + coordinates text remain primary).
  selectionRing.dataset.hasColor = selectedColor !== null ? "true" : "false";
}

function showSelection(): void {
  const colorLabel =
    selectedColor === null ? "none yet" : `${colorName(selectedColor)} (index ${selectedColor})`;

  updatePreview();

  if (!selected) {
    selectionSummary.textContent = `No square selected. Chosen paint: ${colorLabel}. Unpainted squares have no artist.`;
    return;
  }

  const cached = getCachedPixel(pixelCache, selected.x, selected.y);
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

function showWallet(): void {
  if (walletAccount) {
    walletSummary.textContent = `Connected account: ${walletAccount}. Contract: ${
      CONTRACT_ID || "not configured"
    }.`;
    connectButton.textContent = "Disconnect wallet";
  } else {
    walletSummary.textContent = `Not connected. You can still look at the board. Contract: ${
      CONTRACT_ID || "not configured"
    }.`;
    connectButton.textContent = "Connect NEAR wallet";
  }
  const notice = describeNetwork(walletAccount ? walletNetwork : null);
  networkSummary.textContent = notice.message;
}

function fillRules(): void {
  const lines = [
    `The board is ${BOARD_WIDTH} by ${BOARD_HEIGHT} squares.`,
    "Square (0, 0) is the top-left. x counts to the right. y counts downward.",
    "An unpainted square is not a color. It has no stored artist. Palette index 0 is Ink, a real paint color.",
    "Overwrite rule: Open wall. Any connected account may paint any pixel, including one someone else painted. Vandalism is possible.",
    "The current artist is credit for the latest successful write. That is not a legal claim on the artwork.",
    isContractConfigured()
      ? `Game contract: ${CONTRACT_ID} on ${PAGE_NETWORK}. Success requires a transaction id and a matching get_pixel read.`
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
      if (walletAccount && selected) {
        setFlow("editing");
      }
      render();
      showSelection();
    });
    palette.append(button);
  }
}

function setFlow(phase: typeof uiPhase): void {
  uiPhase = phase;
  const labels: Record<typeof uiPhase, string> = {
    disconnected: "State: disconnected — look freely; draw needs a wallet.",
    connected: "State: connected — pick a square and a named color.",
    editing: "State: editing — review the pixel rule, then try to draw.",
    wallet_prompt: "State: wallet prompt — approve or reject in your wallet.",
    pending: "State: pending — waiting for transaction confirmation + board read.",
    success: "State: success — chain read matched your draw.",
    error: "State: error — recoverable; you can change selection or reconnect.",
  };
  flowState.textContent = labels[phase];
  flowState.dataset.phase = phase;
}

/** textContent only. Account ids and error strings must not be inserted as HTML. */
function fillBlock(host: HTMLElement, title: string, message: string): void {
  host.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  host.append(heading, paragraph);
}

function fillResultWithLink(
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

function clearBlock(host: HTMLElement): void {
  host.replaceChildren();
}

function colorName(index: number): string {
  return PALETTE.find((swatch) => swatch.index === index)?.name ?? `index ${index}`;
}

function walletNetworkId(): NetworkId {
  if (
    walletNetwork === "mock" ||
    walletNetwork === "localnet" ||
    walletNetwork === "testnet" ||
    walletNetwork === "mainnet"
  ) {
    return walletNetwork;
  }
  return PAGE_NETWORK;
}
