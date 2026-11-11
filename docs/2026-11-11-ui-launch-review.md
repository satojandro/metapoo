# UI launch review — 11 Nov 2026

One pass over every public page and every wallet surface, to replace filing UI issues one at a
time. Findings are ordered by what a first-time player would hit. Nothing here is fixed yet.

## How this was checked

- Ran `main` at `e0885ef` locally with the production (mainnet) settings and loaded all eight
  routes plus a bad URL at 1440 × 900 and 390 × 844 in headless Chromium.
- Exercised the wall without a wallet: the four views, tile inspection, paint mode, the wallet
  picker.
- **Not tested with a real wallet.** Buy credits, Add funds, Send and Self-custody were mounted
  in a throwaway fixture with stub data, so their layout and copy are reviewed but their live
  transitions (#98, #105) are taken from the issue reports and the code, not reproduced.
- Phone results are an emulated viewport, not a physical device.

## A. Fix before launch

| # | Where | What is wrong | Fix |
|---|---|---|---|
| A1 | Phone: `/toilet`, `/how-it-works`, `/money`, `/wall`, `/stake` | **Pages are wider than the screen.** At 390 px the content column measures 553 px on TOILET, 497 on Money, 488 on Wall, 443 on How it works, 381 on Stake. On TOILET the headline and every paragraph are cut off at the right edge ("Hold the wall. Get paid ir"). One cause: 64-character account ids cannot wrap, and they stretch the grid they sit in. | Shorten ids to `fcd66acf…3076f59e` wherever they appear in prose (the Money accounts table already does this), and give those grid children `min-width: 0` with `overflow-wrap: anywhere` as a backstop. Add the five routes to `web/scripts/layout-check.mjs`, which today only guards the wall. |
| A2 | `/how-it-works`, `/toilet`, `/money` | **Three pages contradict the live product.** How it works ends with "Coming next: Tiles that earn TOILET… Earning switches on in a later round" (`how-it-works-page.ts:253`). TOILET says "Earning is live. Staking is open." and, in the same paragraph, "The staking controls land on this page next" (`toilet-page.ts:326`) although `/stake` exists. The Money diagram labels the stakers' 70% "held on the board until staking opens" (`revenue-flow-svg.ts:43`) while the card below says it is forwarded to the staking contract. | Delete the "Coming next" block or turn it into a link to TOILET; replace the TOILET sentence with a "Stake your TOILET →" link; make the diagram label follow the same staking-set check the card uses. |
| A3 | Buy credits (#98), Add funds (#105) | **A successful payment looks like nothing happened.** Buy credits reloads in place; Add funds keeps showing yesterday's finished quote, with "Track an earlier payment" and the reset buried in small text. The funded state in the fixture shows the old quote and only a "Change" button. | After a confirmed purchase: close the sheet, show one toast ("You have N credits — go paint"), and update the dock. After a funded deposit: show a clear success state with the amount received and one yellow "Done" button; reopening the dialog always starts on a fresh form. Keep the uncertain-outcome states open, as they are today. |
| A4 | Send, Self-custody | **Both read as developer forms** (owner, 11 Nov: "hard to understand"). Send has no balance shown, a full-width "Max" button stacked under the amount, a permanent "Check pending transfer" button with no explanation, and a one-sentence review that runs amount, recipient, fee ceiling and registration together. Self-custody opens on a raw key list (`Privy (your sign-in) · Full access · ed25519:…`), never says what self-custody is or why to want it, and uses the browser's `confirm()` box for removing a key. | Send: show the balance beside the asset, put Max inside the amount field, render the review as labelled rows (You send / To / Network fee, at most / Total), and show "Check pending transfer" only when a transfer is actually unresolved. Self-custody: lead with two sentences on what this does and what it risks, show keys as labelled rows with the key shortened, number the steps (1 create a key in a wallet you control, 2 paste the public key, 3 approve), and replace `confirm()` with an in-panel confirmation. Until then keep `VITE_SELF_CUSTODY_ENABLED` off, as the backlog already recommends. |
| A5 | Site-wide | **No page identity outside the tab.** Every route has the title "Meta Poo"; `index.html` has no description, no social-share image or tags, and no favicon. A shared link shows a bare URL. | Per-route titles ("TOILET · Meta Poo"), a description, Open Graph and Twitter tags with a wall image, and a favicon. This is the cheapest launch-day win on the list. |
| A6 | Unknown URL | **The 404 page is unstyled**: a boxed "Not found" heading jammed against the header, with the text "That path is not a known Meta Poo route." | Use the same hero layout as `/admin`'s signed-out state, in player language: "Nothing painted here." with a button to the wall. |

## B. The wall

| # | What is wrong | Fix |
|---|---|---|
| B1 | **Price and Age are the same picture** (#99): age decides price, so Price (three bands: 4, 2, 1 credits) and Age (a wet-to-dry scale) show the same thing two ways. | One view, "Fresh", with one legend: wet · 4 credits · under 10 min, drying · 2 · under an hour, dry · 1. |
| B2 | **"Cell" and "tile" are both used.** The page says tile everywhere except the paint dock ("This stroke: 1 cell · 1 credit") and the screen-reader readout ("Cell: none selected"). | "Tile" everywhere a player can read it. |
| B3 | **"Also allow painting without a popup each time"** is the first thing under the palette and does not say what it does, what it costs, or that it is safe. | "Paint without approving every stroke" with one line beneath: "Adds a painting key that can only paint here. It can't move your funds. Turn it off any time." |
| B4 | **Long account ids dominate "Right now" and "Who holds the wall".** The top painter is a 64-character id cut off mid-string; the tile inspector on phone prints all 64 characters across three lines. | Shorten to first 8 … last 8 everywhere, full id on tap or hover. Same rule as A1. |
| B5 | **On phone in paint mode, the top row of the palette sat hidden under the wall** in my capture, with the "Connect wallet to paint" bar covering the rest. I could not confirm whether dragging the sheet reveals it. | Verify on a real phone. The palette has to be fully visible the moment paint mode opens. |
| B6 | **The main button changes meaning without changing weight.** "Start painting" becomes "Connect wallet to paint" only after a tile is tapped, so a new visitor picks a colour and a tile before learning a wallet is needed. | Keep it — letting people try first is right — but say it early: under "Start painting", one line, "You'll connect a wallet when you place your first tile." |
| B7 | **Four overlays sit on the art** on desktop (hint, view tabs, freshness + network, zoom) and three on phone, where the view tabs cover the top-right of a 360 px wall. | Move freshness and the network label below the wall next to the progress bar; on phone, move the view tabs there too. |
| B8 | **"About / details"** is a full-width bar at the foot of the page containing "Raw board state" and "Contract & schema". | Rename to "Contract details" and reduce it to a text link in a footer. |
| B9 | **No footer.** The page ends at the details bar: no terms, no contact, no link to report a problem, no social links. | Add a small shared footer. The beta banner supports guide and report links (`VITE_BETA_GUIDE_URL`, `VITE_BETA_REPORT_URL`) but neither is set in production. |

## C. Other pages

| # | Page | What is wrong | Fix |
|---|---|---|---|
| C1 | All | **Disabled buttons look broken, not disabled.** A disabled yellow button turns murky olive (Claim TOILET, Lock TOILET, Claim mPOO); on Money, "Distribute now" turns grey-pink. Each has a different treatment. | One disabled style from the tokens, and where the reason is "no wallet", make the button "Connect wallet" instead of a dead control. |
| C2 | Stake | "Connect a wallet" appears five times as a *value* in coloured text (Your share, Your cut, three rows in Your position), plus twice more as a hint. It looks like five links and none is clickable. | Show "—" for the values and one real Connect button in the position card. |
| C3 | Stake | Stray punctuation in step 3: the heading ends, then the body starts ", a little every moment" (`stake-page.ts:156`). | Move the comma clause into the sentence. |
| C4 | Stake, TOILET | **Two words for one action**: the nav and TOILET page say "Stake", the Stake page says "Lock / Unlock", and TOILET says "burned when you unstake". | Pick one. "Stake / Unstake" matches the nav and the page name. |
| C5 | TOILET | The hard-cap figure "1,000,000,000" renders at 14 px with tight letter-spacing, smaller than the paragraph beneath it — the one number the section is about. | Use the stat style the rest of the page uses. |
| C6 | TOILET, How it works | Both are long (4,300 and 4,800 px on desktop) and both explain the tiers, the 70/20/10 split and the loop. TOILET carries three separate calculators. | Not a launch blocker. After launch, let How it works own the rules and TOILET own the earning, and cut the whale calculator down or move it behind a disclosure. |
| C7 | Money, Stake | "updated 1:16:25 AM" is a wall-clock time in monospace beside a 64-character id. | "Updated just now" / "2 min ago", and shorten the id. |
| C8 | Money | The page leads with two cards that both read "0 … Nothing is waiting, so there is nothing to send" and two dead "Distribute now" buttons, while the interesting numbers (burned so far, bought back) are below. | Lead with the totals; put the two pending-split cards second. |
| C9 | Agents | The copy box prints the page's own origin, which is correct in production; nothing to fix. The "BETA" box repeats the banner at the top of the same page. | Drop the in-page box while the banner is on. |
| C10 | Header (phone) | Six nav items wrap, leaving "Where the money goes" alone on a second line. | Shorten the label to "Money" on phone, or let the row scroll sideways. |

## D. Buy credits and Add funds (layout, from the fixture)

- The sheet's text is 12 px against 14–16 px on the rest of the site, and the cost breakdown is a
  default bulleted list.
- The pay button is pale pink; every other primary action on the site is yellow.
- "Credits: not registered · 0" and "First-time setup (storage) · 0.01 NEAR" are contract words.
  Suggested: "You have 0 credits" and "One-time account setup · 0.01 NEAR".
- "Total attached · 0.035 NEAR (plus network gas)" → "Total · 0.035 NEAR, plus a small network fee".
- Add funds is solid. Two notes: "Native NEAR delivery is checked before the payment address is
  shown" is internal reasoning the player does not need, and the refund address should be shortened.

## E. Account panel (owner screenshots, logged-in wallet, 11 Nov)

The panel is one long scroll of nine unrelated blocks, three of them with a yellow button. It is
the place a player goes to answer "what do I have?", and it answers with developer output.

| # | What is wrong | Fix |
|---|---|---|
| E1 | **A third word for the same thing.** "Price per pixel", "0.0025 NEAR / pixel", "Paint pixels available · 4 pixels" (`paint-wallet-panel.ts:22-23`). The wall says tiles and credits. | "Price per credit" and "Paint credits · 4". With B2 this leaves one vocabulary: you paint *tiles* with *credits*. |
| E2 | **NEAR balance shows 24 decimals**: `1.065470563726758755741822 NEAR`, labelled "NEAR available · before gas". | Four decimals, cut not rounded ("1.0654 NEAR"), label "NEAR in your wallet". |
| E3 | **"mPOO in wallet" has no value** — the label sits over an empty line. | Show "0 mPOO" or a "…" while loading, and hide the row when the board is not selling for mPOO. |
| E4 | **The panel talks about itself**: "Buy credits from the paint dock on the wall. This panel only shows balances." | Replace the sentence with a "Buy credits" button that opens the sheet. |
| E5 | **Two ways to get NEAR, styled as rivals.** A yellow "Add funds from another chain" and a pink "Buy NEAR ↗" with the note "Credits are bought with NEAR on this board. Opens near.com to get NEAR from other chains" — which describes what the yellow button already does in-app. | One primary "Add funds"; "Buy NEAR ↗" as a text link beneath it. Pink is used nowhere else as a button colour (same as D). |
| E6 | **"Send" and "Self-custody" float between sections** with no heading or explanation, touching each other. | Give them a "Move funds out" heading and one line each. Self-custody stays hidden until A4 is done. |
| E7 | **Chain jargon on the claim**: "Your wallet signs. You attach 1 yoctoNEAR and pay gas; the TOILET lands in your wallet." (`toilet.ts:210`; the same wording is on Stake, `staking.ts:275-308`). | "One approval in your wallet, plus a small network fee." |
| E8 | **"Connection details" prints the account and the contract twice**, in full, as sentences; then "Operations: No in-flight wallet operations. Leaving a page does not drop a broadcast transaction."; then a debug line: `mainnet · cc9ad…  · ~9.3 px/cell · updated 30s ago block 223997487. · no app fee`. | Collapse all three into one closed "Technical details" disclosure at the bottom. Show Operations above it only when something is actually pending. |
| E9 | **Disconnect is a yellow primary button**, the same weight as Claim and Add funds. | Secondary style, last in the panel. |
| E10 | **Header layout**: the account chip and "Close" sit on separate rows, and the full 64-character address is repeated directly under the short one. "Updated 12:27:47" is a wall-clock time. | One header row: short address, copy icon, Close. Drop the second address box. "Updated just now". |

Suggested order of blocks: address · balances (credits, NEAR, mPOO, TOILET) · Buy credits / Add
funds · Claim TOILET · Move funds out · links · Technical details · Disconnect.

## F. Paint panel while connected (owner screenshots, 11 Nov)

| # | What is wrong | Fix |
|---|---|---|
| F1 | **The panel shows two prices for one tile.** With a blank tile selected, the Tile card says "Cover it for 1 credit" while the dock directly below says "This stroke: 1 cell · 4 credits". The dock is still describing the tile just painted (now wet, so 4 to repaint); the card describes the tile under the cursor. Nothing says which is which. | The dock describes only the stroke about to be placed. Once a stroke confirms, clear the summary; the confirmation line replaces it. |
| F2 | **A fourth word for a tile**: "Painted. Your square is on the wall." So far: tile (wall), cell (dock), pixel (account panel), square (confirmation). | "Painted. Your tile is on the wall." Closes B2 and E1 together: *tile* and *credit*, nothing else. |
| F3 | **The confirmation is the quietest thing on the panel**: small green text under a stale stroke summary, then "Open transaction in explorer". This is the moment the product exists for. | Make it the dock's headline for a few seconds ("On the wall. −1 credit, 11 left."), pulse the tile on the wall, and reduce the explorer link to a small "View transaction". |
| F4 | **Buying is a small text link**: "Credits: 12 Buy". | "12 credits" as the figure, with a proper secondary "Buy more" button; make it the primary action when the stroke costs more than the balance. |
| F5 | **Dead space.** A third of the panel between the Tile card and the dock is empty, and the Colour card keeps an empty strip where the opt-in checkbox was. | Let the dock sit directly under the Tile card; collapse the empty strip. |
| F6 | **"Painted by" prints the full 64-character id** across three lines as a link. | Shorten (B4). |
| F7 | **The hint wraps to two lines over the art**: "Tap or drag to paint · Space-drag to move", beside a "Move" button, beside the four view tabs. The top fifth of the wall is under controls. | One short hint ("Tap or drag to paint"), dismissed after the first stroke; "Space-drag to move" belongs in a tooltip on Move. See B7. |

## G. Privy approval window and Send (owner screenshots, 11 Nov)

The **Send** approval is the best screen in the product: a title that says exactly what happens
("Send 0.5 NEAR"), three labelled rows, one warning, a button that repeats the amount. Use it as
the model.

| # | What is wrong | Fix |
|---|---|---|
| G1 | **Buying credits gets the generic window**: title "Check and approve", then `Calls: buy_credits_near on fcd66acf…` (64 characters over four lines), "Sends 0.025 NEAR", "Gas limit 30 TGas". A player cannot tell this is the purchase they just asked for. | Give each action the game itself sends the Send treatment: "Buy 10 credits" / Pay 0.025 NEAR / To: the Meta Poo wall / button "Pay 0.025 NEAR". Same for painting, claiming TOILET, staking and adding the painting key. Method name, contract id and gas limit move into "Technical details", which already exists. **This is the same list SEND-HARDEN needs** (the allowlist of receivers and methods the game uses), so do them together. It changes wallet approval copy, so it needs owner sign-off under AGENT.md. |
| G2 | "From" prints the full 64-character account on every approval. | Shorten in the row; full id in Technical details. |
| G3 | **Send sheet**: confirmed as described in A4. Also, the dialog's "Close" is an unstyled grey chip in the top-left corner, outside the panel. | Standard header row with a Close button, as on Buy credits. |

## Suggested order

1. **A1, A2, A5, A6, B2, C3** — small, mechanical, no design decision needed. One PR.
2. **A3** (#98, #105) with **D**, **E** and **F** — the payment sheets, the account panel and the connected paint panel, one PR, needs a real-wallet test.
3. **B1** (#99), **B3, B4, B7–B9, C1, C2, C4, C10** — wall and shared-component tidy. One PR.
4. **A4** and **G** — Send, Self-custody and the approval window, together with SEND-HARDEN. Touches wallet copy, so it needs owner sign-off on the wording.
5. **B5, B6** — check on a physical phone first.

C5–C9 can ride along with whichever PR touches the file.
