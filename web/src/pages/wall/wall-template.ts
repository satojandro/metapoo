/**
 * Wall page markup (stall + board + paint dock + collapsed details).
 * Wallet chrome lives on the app shell so it survives navigation.
 */

import { stallScenery } from "./stall-scenery";

export function wallPageHtml(): string {
  const scenery = stallScenery();

  return `
    <div class="layout wall-layout" data-page="wall">
      <main>
        <div class="wall-intro">
          <div><p class="eyebrow">AN OPEN WALL FOR THE INTERNET</p>
          <h2 data-route-heading>Leave your <em>mark.</em></h2></div>
          <div class="wall-intro-meta">
            <p class="wall-invitation">A shared canvas. An unlikely gallery.</p>
            <p class="wall-runtime-status" aria-label="Testnet and connection status">
              <span>Testnet</span><span>Connection status above</span><span>No app fee</span>
            </p>
          </div>
        </div>

        <section class="stall" aria-label="Toilet stall with pixel wall">
          <div class="stall-scene">
            ${scenery.demoLabelHtml}
            <button id="focus-canvas" class="action scene-focus" type="button" aria-pressed="false">Focus canvas ↗</button>
            <div class="stall-room">
              ${scenery.entranceHtml}

              <div class="stall-back">
                <div class="back-wall-skin">
                  ${scenery.backWallArtHtml}
                  <div class="board-mount">
                    <div class="board-bezel">
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
                    <p class="board-caption" aria-hidden="true">128 × 128 · INTERACTIVE CANVAS</p>
                  </div>
                  ${scenery.toiletHtml}
                </div>
              </div>

              ${scenery.floorHtml}
            </div>
          </div>
        </section>

        <div class="paint-dock">
          <div id="palette" class="palette" role="group" aria-label="Color palette"></div>
          <label class="direct-paint-toggle" for="direct-paint-toggle">
            <input id="direct-paint-toggle" type="checkbox" />
            Direct paint
          </label>
          <button id="draw-button" class="action place" type="button">Place paint</button>
        </div>

        <div class="board-toolbar" role="toolbar" aria-label="Board view">
          <button id="zoom-paint" class="action secondary" type="button">Paint zoom</button>
          <button id="refresh-board" class="action secondary" type="button">Refresh board</button>
        </div>

        <p id="selection-summary" class="summary" aria-live="polite"></p>
        <p id="hover-summary" class="summary hover-summary" aria-live="polite"></p>
        <div id="selection-preview" class="selection-preview" aria-live="polite"></div>

        <section id="pressure-panel" class="pressure-panel" hidden aria-labelledby="pressure-heading">
          <div class="pressure-panel-header">
            <h2 id="pressure-heading" class="pressure-heading">Paint cost</h2>
            <label class="pressure-toggle" for="pressure-toggle">
              <input id="pressure-toggle" type="checkbox" disabled />
              Paint cost
            </label>
          </div>
          <p id="pressure-demo-banner" class="pressure-demo-banner" role="status" hidden></p>
          <div id="pressure-legend" class="pressure-legend"></div>
          <p id="pressure-quote-summary" class="pressure-quote-summary" aria-live="polite"></p>
        </section>

        <section id="placement-quote" class="placement-quote" hidden aria-live="polite">
          <h2 class="placement-quote-heading">Placement quote</h2>
          <p id="placement-quote-body" class="placement-quote-body"></p>
        </section>

        <section id="result" class="result" aria-live="assertive"></section>

        <details class="wall-advanced about wall-about">
          <summary>About / details <span aria-hidden="true">＋</span></summary>
          <aside class="side wall-details-content">
            <section data-wall-detail="instructions">
              <h2>How to paint</h2>
              <p id="board-help" class="help">
                Drag to pan. Scroll or pinch to zoom. Tap a square to select it;
                at Paint zoom, a tap directly places the selected color when a
                drawing session is authorized. Pan and pinch never paint. Arrow
                keys move the selection; Enter places when ready.
              </p>
            </section>
            <section data-wall-detail="bootstrap">
              <h2>About this wall</h2>
              <p id="lede" class="lede wall-lede"></p>
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
      </main>
    </div>
  `;
}
