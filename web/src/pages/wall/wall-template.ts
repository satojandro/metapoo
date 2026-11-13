/**
 * Wall page markup: the framed wall with its pointer controls over the corners, the view
 * tabs and the freshness line under it, one side panel (a bottom sheet on phone) and the
 * collapsed Contract details. The panel is a scrolling body plus a pinned footer, so the
 * primary action and its result are always on screen. Signed out the page is Look;
 * signed in it is Paint (no toggle). Wallet chrome lives on the app shell so it survives
 * navigation.
 */

import { DRAWING_SESSION_GAS_ALLOWANCE_YOCTO, formatAllowanceNear } from "../../drawing-session";
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
  return `
    <div class="wall-page" data-page="wall" data-mode="look" data-moving="false" data-signed-in="false">
      <h2 class="visually-hidden" data-route-heading>The wall</h2>
      <main class="wall-main">
        <section class="wall-stage" aria-label="The wall">
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

            <!-- Controls float over the wall's corners so the wall gets the height. -->
            <div class="board-toolbar wall-bar" role="toolbar" aria-label="Wall controls">
              <!-- Move sits beside the hint on every pointer: it is how you browse and
                   ask about tiles in Paint mode without painting them (owner, 7 Nov).
                   Space-drag belongs in this tooltip, not in the hint: the hint has to
                   fit one line or it costs the top of the wall (owner, 11 Nov). -->
              <div class="wall-bar-lead">
                <button id="wall-move" class="wall-move" type="button" aria-pressed="false" hidden
                  title="Drag moves the wall, and a tap shows a tile instead of painting. While painting, hold Space and drag to move.">Move</button>
                <p class="wall-chip wall-gesture-hint" data-for-mode="look">Tap a tile to see who painted it</p>
                <p class="wall-chip wall-gesture-hint" data-for-mode="paint">Tap or drag to paint</p>
                <p class="wall-chip wall-gesture-hint" data-for-mode="moving">Drag to move · tap a tile to see it · nothing paints</p>
              </div>
              <!-- Full screen: the wall takes the window; the panel floats and can hide. -->
              <button id="wall-fullscreen" class="wall-icon-btn wall-fullscreen-btn" type="button"
                aria-pressed="false" aria-label="Full screen" title="Full screen">
                <svg class="icon-enter" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"></path><path d="M20 9V4h-5"></path><path d="M4 15v5h5"></path><path d="M20 15v5h-5"></path></svg>
                <svg class="icon-exit" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4"></path><path d="M15 4v5h5"></path><path d="M9 20v-5H4"></path><path d="M15 20v-5h5"></path></svg>
              </button>
              <button id="wall-panel-toggle" class="wall-chip-btn wall-panel-toggle" type="button"
                aria-controls="wall-panel" aria-expanded="true" hidden>Hide panel</button>
            </div>
          </div>

          <!-- What you are looking at, and how fresh it is, sit under the art rather than
               on it: with the pin hint, the view tabs and the freshness chip all floating
               over the corners, the top fifth of the wall was under controls, and on a
               360 px phone the tabs covered the top-right of the picture (UI review B7). -->
          <div class="mp-seg mp-seg-small wall-views" role="group" aria-label="Wall view">
            <button type="button" data-wall-view="art" aria-pressed="true" title="The picture as painted">Art</button>
            <button type="button" data-wall-view="fresh" aria-pressed="false" title="How fresh each tile is, and what covering it costs">Fresh</button>
            <button type="button" data-wall-view="turf" aria-pressed="false" title="Who holds the most tiles">Turf</button>
          </div>

          <div class="wall-foot">
            <p id="board-freshness" class="board-freshness" role="status" aria-live="polite">Reading the wall…</p>
            <button id="refresh-board" class="wall-refresh" type="button" aria-label="Refresh the wall now">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"></path><path d="M21 4v5h-5"></path></svg>
            </button>
            <p id="hover-summary" class="hover-summary" aria-live="polite"></p>
            <p class="wall-runtime-status" aria-label="Network"><span>${NETWORK_BADGE[network]}</span></p>
          </div>

          <!-- The pulse: how full the wall is, how much is wet, when happy hour is. -->
          <div class="wall-pulse" data-wall-pulse aria-label="The wall right now" hidden>
            <div class="wall-meter" role="img" data-wall-meter><i></i></div>
            <p class="wall-pulse-line">
              <span class="wall-pulse-fill" data-wall-meter-label></span>
              <span class="wall-pulse-blank" data-pulse-blank></span>
              <span class="wall-pulse-wet" data-pulse-wet></span>
              <span class="wall-pulse-happy" data-wall-happy hidden></span>
            </p>
          </div>
        </section>

        <aside id="wall-panel" class="wall-panel" aria-label="Wall panel">
          <div class="wall-panel-body">
            <section class="wall-card wall-invite" data-wall-card="look" data-state="loading">
              <p class="mp-eyebrow">The wall</p>
              <h3>Leave your mark. <em>Cover someone else’s.</em></h3>
              <!-- The counts, the fill meter and happy hour are in the pulse under the wall. -->
              <p class="wall-earn" data-wall-earn hidden></p>
              <p class="wall-invite-body">Everything here was painted by someone. Tap a tile to see who. Fresh paint costs more to cover, so new work gets a moment on the wall.</p>
              <p class="wall-invite-free" hidden></p>
              <!-- Phones hide the primary nav, so this is their route to /agents. -->
              <p class="wall-invite-agents"><a href="/agents">Or let your agent paint →</a></p>
            </section>

            <!-- The active view's key comes first: it describes what you are looking at. -->
            <section id="wall-view-legend" class="wall-card wall-legend" aria-label="View legend" hidden></section>

            <!-- Paint mode's body is the palette. Cost, credits and status live in the
                 footer; one-off confirmations fade; standing instructions are on the wall. -->
            <div class="paint-dock wall-card wall-dock" data-wall-card="paint">
              <div id="wall-hint-host" class="wall-hint-host"></div>
              <div class="wall-colour-head">
                <p class="mp-eyebrow">Colour</p>
                <div id="selection-preview" class="selection-preview" aria-live="polite"></div>
              </div>
              <div id="palette" class="palette" role="group" aria-label="Color palette"></div>
              <div id="buy-credits-host" class="buy-credits-host"></div>
              <div id="paint-unlock" class="paint-unlock" hidden>
                <p class="paint-unlock-title">Painting is read-only until you approve one drawing key.</p>
                <p class="paint-unlock-body">
                  Approve once and this browser can place pixels without a wallet
                  popup for every square. The key can only paint on this wall, and
                  on a paid wall painting will spend your paint credits.
                  It cannot send NEAR or tokens from your wallet. You can revoke it
                  any time under Contract details, at the foot of this page.
                </p>
                <button id="unlock-paint-button" class="mp-btn action unlock" type="button">
                  Unlock painting — one approval
                </button>
              </div>
              <div id="paint-renew" class="paint-unlock" role="group" aria-labelledby="paint-renew-title" hidden>
                <p id="paint-renew-title" class="paint-unlock-title">Your painting key needs renewing.</p>
                <p class="paint-unlock-body">
                  Nothing is wrong with your wallet. The key that lets this browser
                  paint without a popup has a limit for network fees, and it has run
                  low. Approve one transaction to replace it with a new key with a fresh
                  ${formatAllowanceNear(DRAWING_SESSION_GAS_ALLOWANCE_YOCTO)} limit,
                  spent from your wallet only as you paint. Your wallet may show the
                  old key being removed.
                </p>
                <button id="renew-paint-button" class="mp-btn action unlock" type="button">
                  Renew painting key — one approval
                </button>
              </div>
              <p id="paint-unlocked" class="paint-unlocked" role="status" aria-live="polite" hidden></p>
              <!-- Spoken, not shown: the wall's own hint chip says the same thing. -->
              <p id="tap-to-paint-status" class="tap-to-paint-status visually-hidden" role="status" aria-live="polite" hidden></p>
              <div id="wall-optin-slot" class="wall-optin"></div>
            </div>

            <section class="wall-card wall-inspect" aria-labelledby="wall-tile-heading">
              <p id="wall-tile-heading" class="mp-eyebrow">Tile</p>
              <p id="selection-summary" class="summary" aria-live="polite" aria-atomic="true"></p>
              <div id="tile-inspector" class="tile-inspector" hidden></div>
            </section>

            <!-- Look mode: the latest strokes, from the wall's own paint times. -->
            <section class="wall-card wall-recent" data-wall-card="look" aria-labelledby="wall-recent-heading" hidden>
              <p id="wall-recent-heading" class="mp-eyebrow">Right now</p>
              <ol class="wall-recent-list" data-wall-recent></ol>
              <p class="wall-legend-note">Latest paint on each tile. Tap one to see it on the wall.</p>
            </section>

            <!-- Look mode: the Turf ranking, always in view, with what each holder earns. -->
            <section class="wall-card wall-holders" data-wall-card="look" aria-labelledby="wall-holders-heading" hidden>
              <p id="wall-holders-heading" class="mp-eyebrow">Who holds the wall</p>
              <ol class="wall-turf-list" data-wall-holders></ol>
              <p class="wall-legend-note" data-wall-holders-note></p>
            </section>
          </div>

          <!-- Always in view: the one primary action and what just happened. -->
          <div class="wall-panel-foot">
            <div class="wall-foot-look" data-wall-card="look">
              <button id="start-painting" class="mp-btn mp-btn-primary wall-primary" type="button">Start painting</button>
              <!-- B6: say it before the first tap, not after the tile is chosen. Trying the
                   wall without a wallet is deliberate; learning then that a wallet is needed
                   is not. -->
              <p class="wall-primary-note">You’ll connect a wallet when you place your first tile.</p>
            </div>
            <div class="paint-dock wall-dock-foot" data-wall-card="paint">
              <div class="wall-tally">
                <div class="wall-cost">
                  <!-- The Fresh view's key explains wet paint; this copy stays for screen readers. -->
                  <p id="repaint-legend" class="repaint-legend visually-hidden" hidden></p>
                  <p id="cell-price" class="cell-price visually-hidden" role="status" aria-live="polite"></p>
                  <p id="stroke-total" class="stroke-total" role="status" aria-live="polite"></p>
                  <p id="stroke-earn" class="stroke-earn" hidden></p>
                </div>
                <!-- The figure you have, then the way to get more. "Credits: 12 Buy"
                     read as a label with a text link where the number should be
                     (owner, 11 Nov). The unit is a sibling so the figure can stand
                     alone; CSS hides it while the figure is not a number. -->
                <div id="credits-dock" class="credits-dock" hidden>
                  <p class="credits-figure" role="status" aria-live="polite">
                    <span id="credits-balance" class="credits-balance" data-state="unknown">…</span>
                    <span class="credits-unit">credits</span>
                  </p>
                  <button id="buy-credits-button" class="mp-btn wall-buy-more" type="button">Buy more</button>
                </div>
              </div>
              <div class="wall-action">
                <button id="dock-primary" class="mp-btn mp-btn-primary wall-primary" type="button" hidden></button>
                <button id="draw-button" class="mp-btn mp-btn-primary wall-primary action place" type="button">Paint this tile</button>
                <p id="place-reason" class="place-reason" aria-live="polite"></p>
              </div>
              <p id="draw-state" class="draw-state" role="status" aria-live="polite"></p>
              <section id="result" class="result" role="status" aria-live="polite" aria-atomic="true"></section>
              <button id="wall-back-to-look" class="wall-link" type="button">Just looking</button>
            </div>
          </div>
        </aside>
      </main>

      <!-- Signed in, below the wall: your tiles, your TOILET, what happened since you last looked. -->
      <section class="wall-yours" aria-labelledby="wall-yours-heading" hidden>
        <div class="wall-yours-main">
          <p id="wall-yours-heading" class="mp-eyebrow">Your tiles</p>
          <p class="wall-yours-covered" data-yours-covered hidden>
            <span data-yours-covered-text></span>
            <button type="button" class="wall-link" data-yours-show-covered hidden>Show me</button>
          </p>
          <div class="wall-yours-count">
            <span class="wall-yours-figure" data-yours-tiles>…</span>
            <span class="wall-yours-unit">tiles you hold on the wall</span>
          </div>
          <p class="wall-yours-note">Only tiles you painted with credits earn TOILET. “Since you last looked” is what this browser remembers, not a history the wall keeps.</p>
          <button type="button" class="mp-btn wall-yours-mine" data-yours-show-mine hidden>Show my tiles</button>
        </div>
        <div class="wall-yours-claim" data-yours-claim></div>
      </section>

      <!-- Below the wall: the rules in three lines, each leading to the page that explains it. -->
      <section class="wall-story" aria-labelledby="wall-story-heading">
        <p id="wall-story-heading" class="mp-eyebrow">How the stall works</p>
        <div class="wall-rules" data-wall-rules></div>
      </section>

        <details class="wall-advanced about wall-about">
          <summary>Contract details <span aria-hidden="true">＋</span></summary>
          <aside class="side wall-details-content">
            <section data-wall-detail="instructions">
              <h2>How to paint</h2>
              <p class="board-legend">
                A filled square is painted on chain. A magenta corner dot
                means the paint was sent but not confirmed yet. The white
                ring marks the square you have selected.
              </p>
              <p id="board-help" class="help">
                Signed out, drag moves the wall and a tap shows a tile. Signed
                in, drag paints a stroke once a drawing key is approved, and a
                tap chooses a square. To move the wall while painting, hold
                space, use the middle or right mouse button, use two fingers, or
                turn on Move on a touch screen. Scroll or pinch to zoom. Arrow
                keys move the selection; Enter paints when ready.
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
              <label class="direct-paint-toggle" for="direct-paint-toggle">
                <input id="direct-paint-toggle" type="checkbox" />
                Paint as soon as I tap or drag
              </label>
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
