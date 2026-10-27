/**
 * Wall page markup (stall + board + paint dock + collapsed details).
 * Wallet chrome lives on the app shell so it survives navigation.
 */

export function wallPageHtml(): string {
  const scenery = {
    demoLabelHtml:
      '<div class="scene-label" data-stall-scenery="scene-label" aria-hidden="true">DEMO STALL ART <span>LIVE BOARD</span></div>',
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
            <p id="board-freshness" class="board-freshness wall-runtime-status" role="status" aria-live="polite">Board not read yet.</p>
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
                    <p class="board-legend">
                      A filled square is painted on chain. A magenta corner dot
                      means the paint was sent but not confirmed yet.
                    </p>
                  </div>
                  ${scenery.toiletHtml}
                </div>
              </div>

              ${scenery.floorHtml}
            </div>
          </div>
        </section>

        <div class="paint-dock">
          <div id="paint-unlock" class="paint-unlock" hidden>
            <p class="paint-unlock-title">Painting is read-only until you approve one drawing key.</p>
            <p class="paint-unlock-body">
              Approve once and this browser can place pixels without a wallet
              popup for every square. The key can paint and nothing else — it
              cannot move your funds. You can revoke it any time under
              About / details.
            </p>
            <button id="unlock-paint-button" class="action unlock" type="button">
              Unlock painting — one approval
            </button>
          </div>
          <div id="palette" class="palette" role="group" aria-label="Color palette"></div>
          <label class="direct-paint-toggle" for="direct-paint-toggle">
            <input id="direct-paint-toggle" type="checkbox" />
            Direct paint
          </label>
          <p id="tap-to-paint-status" class="tap-to-paint-status" role="status" aria-live="polite" hidden></p>
          <p id="paint-unlocked" class="paint-unlocked" role="status" aria-live="polite" hidden></p>
          <button id="draw-button" class="action place" type="button">Place paint</button>
          <p id="draw-state" class="draw-state" role="status" aria-live="polite"></p>
        </div>

        <div class="board-toolbar" role="toolbar" aria-label="Board view">
          <button id="zoom-paint" class="action secondary" type="button">Paint zoom</button>
          <button id="refresh-board" class="action secondary" type="button">Refresh board</button>
        </div>

        <p id="selection-summary" class="summary" aria-live="polite" aria-atomic="true"></p>
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

        <section id="result" class="result" role="status" aria-live="polite" aria-atomic="true"></section>

        <details class="wall-advanced about wall-about">
          <summary>About / details <span aria-hidden="true">＋</span></summary>
          <aside class="side wall-details-content">
            <section data-wall-detail="instructions">
              <h2>How to paint</h2>
              <p id="board-help" class="help">
                Drag to paint once a drawing key is approved; click selects a
                square. To move the board, hold space and drag, use the middle
                mouse button, or use two fingers on a touchscreen. Scroll or
                pinch to zoom. Arrow keys move the selection; Enter places when
                ready.
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
