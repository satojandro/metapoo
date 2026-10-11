import "./style.css";
import { PALETTE } from "@shared/palette.ts";
import { BOARD_HEIGHT, BOARD_WIDTH, type NetworkId } from "@shared/types.ts";
import { CONTRACT_ID, PAGE_NETWORK, SPONSORSHIP_ENABLED } from "./config";
import { prepareDraw } from "./draw-policy";
import { describeNetwork } from "./network";
import { bitmapHex, emptyHexAt, renderBoard } from "./render-board";
import { cellFromOffset, moveSelection, type Cell } from "./selection";
import { connectWallet, disconnectWallet, onWalletSession } from "./wallet";

/**
 * Page wiring. The board picture is a local empty mock. Coloring a square in
 * this file would be a lie, because no transaction has been confirmed.
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

let selected: Cell | null = null;
let selectedColor: number | null = null;
let walletAccount: string | null = null;
let walletNetwork: string | null = null;

evidence.textContent =
  "Evidence: local mock. This picture is an empty board drawn in your browser. It is not testnet or mainnet state, and it is not a live user journey.";

sponsorNote.textContent = SPONSORSHIP_ENABLED
  ? "Sponsorship flag is on. That is unexpected in this build."
  : "Gas sponsorship is off. No sponsor key is in this project. The game does not charge an MPOO or NEAR application fee. A later draw would still need your wallet to pay network gas once a contract id is configured.";

fillRules();
buildPalette();
render();
showSelection();

drawButton.addEventListener("click", () => {
  attemptDraw();
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
  render();
  showSelection();
  boardFocus.focus();
});

boardFocus.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    attemptDraw();
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
    render();
    showSelection();
  }
});

onWalletSession((session) => {
  walletAccount = session.accountId;
  walletNetwork = session.networkId;
  showWallet();
});

function attemptDraw(): void {
  const decision = prepareDraw({
    x: selected?.x ?? null,
    y: selected?.y ?? null,
    color: selectedColor,
    connected: walletAccount !== null,
    accountId: walletAccount,
    sessionNetworkId: walletNetworkId(),
    boardNetworkId: PAGE_NETWORK,
  });
  fillBlock(result, decision.title, decision.message);

  // A successful paint would change a bitmap pixel. This check makes the
  // "we did not paint" rule visible while you are looking at the page.
  if (selected) {
    const painted = bitmapHex(canvas, selected.x, selected.y);
    const empty = emptyHexAt(selected.x, selected.y);
    if (painted !== empty) {
      fillBlock(
        result,
        "The local picture changed unexpectedly",
        "The empty-board color no longer matches. Treat the picture as unreliable and reload.",
      );
    }
  }
}

async function onConnectClick(): Promise<void> {
  clearBlock(walletError);
  connectButton.disabled = true;
  try {
    if (walletAccount) {
      await disconnectWallet();
    } else {
      await connectWallet();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown wallet error";
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
  renderBoard(canvas);
  // The ring is HTML, not bitmap paint, so a draw attempt cannot recolor a square.
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
}

function showSelection(): void {
  const colorName =
    PALETTE.find((swatch) => swatch.index === selectedColor)?.name ??
    "none yet";
  if (!selected) {
    selectionSummary.textContent = `No square selected. Color: ${colorName}. Unpainted squares have no artist.`;
    return;
  }
  selectionSummary.textContent = `Selected square x=${selected.x}, y=${selected.y}. Color: ${colorName}. Counting starts at the top-left. This square is unpainted.`;
}

function showWallet(): void {
  if (walletAccount) {
    walletSummary.textContent = `Connected account: ${walletAccount}. Contract: ${
      CONTRACT_ID || "not configured"
    }.`;
    connectButton.textContent = "Disconnect wallet";
  } else {
    walletSummary.textContent =
      "Not connected. You can still look at the board. Contract: not configured.";
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
    "This page still has no game contract id configured, so it will not open a draw signature or claim a chain success.",
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
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = swatch.hex;
    chip.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = swatch.name;
    button.append(chip, label);
    button.addEventListener("click", () => {
      selectedColor = swatch.index;
      for (const other of palette.querySelectorAll("button")) {
        other.setAttribute("aria-pressed", other === button ? "true" : "false");
      }
      showSelection();
    });
    palette.append(button);
  }
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

function clearBlock(host: HTMLElement): void {
  host.replaceChildren();
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
