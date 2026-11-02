/**
 * Wall page markup: the wall first (view bar, framed board, foot line), one side panel
 * (a bottom sheet on phone) for Look and Paint, and the collapsed About / details.
 * Wallet chrome lives on the app shell so it survives navigation.
 */

import { PAGE_NETWORK } from "../../config";
import type { NetworkId } from "@shared/types.ts";

/** Short badge text; `NETWORK_LABEL` in shared/types is the long explanatory form. */
const NETWORK_BADGE: Record<NetworkId, string> = {
  mock: "Local preview",
  localnet: "Localnet",
  testnet: "Testnet",
  mainnet: "Mainnet",
};

export function wallPageHtml(network: NetworkId = PAGE_NETWORK): string {
  const scenery = {
    entranceHtml: `
      <div class="stall-ceiling" data-stall-scenery="ceiling" aria-hidden="true"></div>
      <div class="stall-wall stall-wall-left" data-stall-scenery="left-wall" aria-hidden="true">
        <div class="wall-skin"><div class="wall-marks wall-marks-left"></div><div class="wall-fasteners"></div></div>
      </div>
      <div class="stall-wall stall-wall-right" data-stall-scenery="right-wall" aria-hidden="true">
        <div class="wall-skin"><div class="wall-marks wall-marks-right"></div><div class="wall-fasteners"></div></div>
      </div>`,
    backWallArtHtml:
      '<div class="back-wall-marks" data-stall-scenery="back-wall-art" aria-hidden="true"></div>',
    toiletHtml: `
      <div class="stall-toilet" data-stall-scenery="toilet" aria-hidden="true">
        <svg class="toilet-svg" viewBox="0 0 120 88" xmlns="http://www.w3.org/2000/svg" focusable="false">
          <ellipse cx="60" cy="78" rx="34" ry="6" fill="#1a1512" opacity="0.45" />
          <rect x="28" y="8" width="64" height="18" rx="4" fill="#c8d0d6" stroke="#5a6570" stroke-width="2" />
          <rect x="78" y="2" width="14" height="10" rx="2" fill="#9aa6b0" stroke="#5a6570" stroke-width="1.5" />
          <path d="M22 28h76c4 0 8 4 8 9v18c0 14-16 26-46 26S14 69 14 55V37c0-5 4-9 8-9z" fill="#e8eef2" stroke="#5a6570" stroke-width="2" />
          <ellipse cx="60" cy="48" rx="28" ry="16" fill="#3d6f8a" stroke="#2a4f62" stroke-width="2" />
          <ellipse cx="60" cy="46" rx="18" ry="10" fill="#2a556b" opacity="0.85" />
          <path d="M48 44c4-3 20-3 24 0" fill="none" stroke="#7eb8d4" stroke-width="2" stroke-linecap="round" opacity="0.7" />
        </svg>
      </div>`,
    floorHtml:
      '<div class="stall-floor" data-stall-scenery="floor" aria-hidden="true"><div class="floor-grate"></div></div>',
  };

  return `
    <div class="wall-page" data-page="wall" data-mode="look" data-moving="false">
      <h2 class="visually-hidden" data-route-heading>The wall</h2>
      <main class="wall-main">
        <section class="wall-stage" aria-label="The wall">
          <div class="board-toolbar wall-bar" role="toolbar" aria-label="Wall controls">
            <div class="mp-seg wall-mode" role="group" aria-label="Mode">
              <button id="wall-mode-look" type="button" data-wall-mode="look" aria-pressed="true">Look</button>
              <button id="wall-mode-paint" type="button" data-wall-mode="paint" aria-pressed="false">Paint</button>
            </div>
            <button id="wall-move" class="wall-move" type="button" aria-pressed="false" hidden
              title="Drag moves the wall instead of painting">Move</button>
            <div class="mp-seg mp-seg-small wall-views" role="group" aria-label="Wall view">
              <button type="button" data-wall-view="art" aria-pressed="true">Art</button>
              <button type="button" data-wall-view="price" aria-pressed="false" disabled title="Coming next">Price</button>
              <button type="button" data-wall-view="age" aria-pressed="false" disabled title="Coming next">Age</button>
              <button type="button" data-wall-view="turf" aria-pressed="false" disabled title="Coming next">Turf</button>
            </div>
          </div>

          <div class="wall-frame">
            <div
              id="board-focus"
              class="board-focus"
              tabindex="0"
              role="application"
              aria-label="Pixel board"
              aria-describedby="board-help selection-summary"
            >
              <div id="board-viewport" class="board-viewport">
                <div id="board-stage" class="board-stage">
                  <canvas id="board" width="512" height="512">
                    A 128 by 128 pixel board. Use the selection text if
                    the picture does not load.
                  </canvas>
                </div>
                <div id="selection-ring" hidden></div>
              </div>
            </div>
          </div>

          <div class="wall-foot">
            <p id="board-freshness" class="board-freshness" role="status" aria-live="polite">Reading the wall…</p>
            <p id="hover-summary" class="hover-summary" aria-live="polite"></p>
            <p class="wall-runtime-status" aria-label="Network"><span>${NETWORK_BADGE[network]}</span></p>
          </div>
        </section>

        <aside class="wall-panel" aria-label="Wall panel">
          <section class="wall-card wall-invite" data-wall-card="look">
            <p class="mp-eyebrow">The wall</p>
            <h3>Leave your mark. <em>Cover someone else’s.</em></h3>
            <p>Everything here was painted by someone. Tap a tile to see who. Fresh paint costs more to cover, so new work gets a moment on the wall.</p>
            <button id="start-painting" class="mp-btn mp-btn-primary wall-primary" type="button">Start painting</button>
          </section>

          <div class="paint-dock wall-card wall-dock" data-wall-card="paint">
            <div id="wall-hint-host" class="wall-hint-host"></div>
            <div id="palette" class="palette" role="group" aria-label="Color palette"></div>
            <div id="selection-preview" class="selection-preview" aria-live="polite"></div>
            <div class="wall-cost">
              <p id="repaint-legend" class="repaint-legend" hidden></p>
              <p id="cell-price" class="cell-price" role="status" aria-live="polite"></p>
              <p id="stroke-total" class="stroke-total" role="status" aria-live="polite"></p>
            </div>
            <div id="credits-dock" class="credits-dock" hidden>
              <p id="credits-balance" class="credits-balance" role="status" aria-live="polite">Credits: …</p>
              <button id="buy-credits-button" class="mp-btn" type="button">Buy credits</button>
            </div>
            <div id="buy-credits-host" class="buy-credits-host"></div>
            <div id="paint-unlock" class="paint-unlock" hidden>
              <p class="paint-unlock-title">Painting is read-only until you approve one drawing key.</p>
              <p class="paint-unlock-body">
                Approve once and this browser can place pixels without a wallet
                popup for every square. The key can only paint on this wall, and
                on a paid wall painting will spend your paint credits.
                It cannot send NEAR or tokens from your wallet. You can revoke it
                any time under About / details.
              </p>
              <button id="unlock-paint-button" class="mp-btn action unlock" type="button">
                Unlock painting — one approval
              </button>
            </div>
            <label class="direct-paint-toggle" for="direct-paint-toggle">
              <input id="direct-paint-toggle" type="checkbox" />
              Drag to paint strokes
            </label>
            <p id="tap-to-paint-status" class="tap-to-paint-status" role="status" aria-live="polite" hidden></p>
            <p id="paint-unlocked" class="paint-unlocked" role="status" aria-live="polite" hidden></p>
            <div class="wall-action">
              <button id="dock-primary" class="mp-btn mp-btn-primary wall-primary" type="button" hidden></button>
              <button id="draw-button" class="mp-btn mp-btn-primary wall-primary action place" type="button">Paint this tile</button>
              <p id="place-reason" class="place-reason" aria-live="polite"></p>
            </div>
            <p id="draw-state" class="draw-state" role="status" aria-live="polite"></p>
            <section id="result" class="result" role="status" aria-live="polite" aria-atomic="true"></section>
            <button id="wall-back-to-look" class="wall-link" type="button">Done painting</button>
          </div>

          <section class="wall-card wall-inspect" aria-labelledby="wall-tile-heading">
            <p id="wall-tile-heading" class="mp-eyebrow">Tile</p>
            <p id="selection-summary" class="summary" aria-live="polite" aria-atomic="true"></p>
          </section>

          <p class="wall-refresh"><button id="refresh-board" class="wall-link" type="button">Refresh the wall now</button></p>
        </aside>
      </main>

      <!-- Step 1 keeps these mounted but out of the composition; step 4 deletes them. -->
      <div class="wall-legacy" hidden>
        <button id="focus-canvas" type="button" aria-pressed="false" tabindex="-1">Focus canvas ↗</button>
        <button id="zoom-paint" type="button" tabindex="-1">Paint zoom</button>
        <div class="stall-room">
          ${scenery.entranceHtml}
          ${scenery.backWallArtHtml}
          ${scenery.toiletHtml}
          ${scenery.floorHtml}
        </div>
      </div>
        <details class="wall-advanced about wall-about">
          <summary>About / details <span aria-hidden="true">＋</span></summary>
          <aside class="side wall-details-content">
            <section data-wall-detail="instructions">
              <h2>How to paint</h2>
              <p class="board-legend">
                A filled square is painted on chain. A magenta corner dot
                means the paint was sent but not confirmed yet. The white
                ring marks the square you have selected.
              </p>
              <p id="board-help" class="help">
                Look mode: drag moves the wall and a tap shows a tile. Paint
                mode: drag paints a stroke once a drawing key is approved, and a
                tap chooses a square. To move the wall while painting, turn on
                Move, hold space, use the middle or right mouse button, or use
                two fingers. Scroll or pinch to zoom. Arrow keys move the
                selection; Enter paints when ready.
              </p>
            </section>
            <section data-wall-detail="bootstrap">
              <h2>About this wall</h2>
              <p id="lede" class="lede wall-lede"></p>
              <p id="wall-contract-line" class="wall-contract-line"></p>
            </section>
            <section data-wall-detail="board-state">
              <h2>Raw board state</h2>
              <p id="board-load-status" class="board-load-status" aria-live="polite"></p>
            </section>
            <section data-wall-detail="contract-schema">
              <h2>Contract &amp; schema</h2>
              <p id="evidence" class="evidence"></p>
            </section>
            <section data-wall-detail="rules">
              <h2>Wall rules</h2>
              <div id="rules"></div>
            </section>
            <section class="drawing-session" aria-labelledby="drawing-session-heading">
              <h2 id="drawing-session-heading">Drawing session</h2>
              <p id="drawing-session-status"></p>
              <div class="drawing-session-actions">
                <button id="authorize-session-button" class="action secondary" type="button" disabled>
                  Authorize drawing session
                </button>
                <button id="forget-session-button" class="action secondary" type="button" disabled>
                  Forget session in this browser
                </button>
                <button id="revoke-session-button" class="action secondary" type="button" disabled>
                  Revoke session on-chain
                </button>
              </div>
              <p id="drawing-session-note" class="help"></p>
            </section>
            <section>
              <h2>Fees</h2>
              <p id="sponsor-note"></p>
            </section>
          </aside>
        </details>
    </div>
  `;
}
