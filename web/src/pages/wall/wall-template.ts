/**
 * Wall page markup (stall + board + paint dock + side panel).
 * Wallet chrome lives on the app shell so it survives navigation.
 */

export function wallPageHtml(): string {
  return `
    <div class="layout wall-layout" data-page="wall">
      <main>
        <p id="lede" class="lede wall-lede"></p>

        <section class="stall" aria-label="Toilet stall with pixel wall">
          <div class="stall-scene">
            <div class="stall-room">
              <div class="stall-ceiling" aria-hidden="true"></div>

              <div class="stall-wall stall-wall-left" aria-hidden="true">
                <div class="wall-skin">
                  <div class="wall-marks wall-marks-left"></div>
                  <div class="wall-fasteners"></div>
                </div>
              </div>

              <div class="stall-wall stall-wall-right" aria-hidden="true">
                <div class="wall-skin">
                  <div class="wall-marks wall-marks-right"></div>
                  <div class="wall-fasteners"></div>
                </div>
              </div>

              <div class="stall-back">
                <div class="back-wall-skin">
                  <div class="back-wall-marks" aria-hidden="true"></div>
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
                            <div id="selection-ring" hidden></div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <p class="board-caption" aria-hidden="true">shared pixel wall</p>
                  </div>

                  <div class="stall-toilet" aria-hidden="true">
                    <svg
                      class="toilet-svg"
                      viewBox="0 0 120 88"
                      xmlns="http://www.w3.org/2000/svg"
                      focusable="false"
                    >
                      <ellipse cx="60" cy="78" rx="34" ry="6" fill="#1a1512" opacity="0.45" />
                      <rect x="28" y="8" width="64" height="18" rx="4" fill="#c8d0d6" stroke="#5a6570" stroke-width="2" />
                      <rect x="78" y="2" width="14" height="10" rx="2" fill="#9aa6b0" stroke="#5a6570" stroke-width="1.5" />
                      <path d="M22 28h76c4 0 8 4 8 9v18c0 14-16 26-46 26S14 69 14 55V37c0-5 4-9 8-9z" fill="#e8eef2" stroke="#5a6570" stroke-width="2" />
                      <ellipse cx="60" cy="48" rx="28" ry="16" fill="#3d6f8a" stroke="#2a4f62" stroke-width="2" />
                      <ellipse cx="60" cy="46" rx="18" ry="10" fill="#2a556b" opacity="0.85" />
                      <path d="M48 44c4-3 20-3 24 0" fill="none" stroke="#7eb8d4" stroke-width="2" stroke-linecap="round" opacity="0.7" />
                    </svg>
                  </div>
                </div>
              </div>

              <div class="stall-floor" aria-hidden="true">
                <div class="floor-grate"></div>
              </div>
            </div>
          </div>
        </section>

        <div class="board-toolbar" role="toolbar" aria-label="Board view">
          <button id="zoom-out" class="action secondary" type="button">Zoom out</button>
          <button id="zoom-in" class="action secondary" type="button">Zoom in</button>
          <button id="zoom-fit" class="action secondary" type="button">Fit wall</button>
          <button id="zoom-paint" class="action secondary" type="button">Paint zoom</button>
          <button id="refresh-board" class="action secondary" type="button">Refresh board</button>
          <p id="board-load-status" class="board-load-status" aria-live="polite"></p>
        </div>

        <p id="board-help" class="help">
          Drag to pan. Scroll or pinch to zoom. Tap a square to select it. Pan
          and pinch never paint — use Place paint (or Direct paint after a
          drawing session). Arrow keys move the selection; Enter places when
          ready.
        </p>
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

        <div class="paint-dock">
          <div id="palette" class="palette" role="group" aria-label="Color palette"></div>
          <label class="direct-paint-toggle" for="direct-paint-toggle">
            <input id="direct-paint-toggle" type="checkbox" />
            Direct paint
          </label>
          <button id="draw-button" class="action place" type="button">Place paint</button>
        </div>
        <section id="result" class="result" aria-live="assertive"></section>
      </main>

      <aside class="side">
        <section class="drawing-session" aria-labelledby="drawing-session-heading">
          <h2 id="drawing-session-heading">Drawing session (experimental)</h2>
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
        <details class="about">
          <summary>About, rules, and contract detail</summary>
          <p id="evidence" class="evidence"></p>
          <h3>Rules on this page</h3>
          <div id="rules"></div>
        </details>
      </aside>
    </div>
  `;
}
