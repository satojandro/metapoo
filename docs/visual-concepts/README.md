# Visual concepts

Design references for the site. Open the `.html` files directly in a browser; they need no build.

## Approved page designs (2 November 2026)

| page | draft | what it settles |
|---|---|---|
| `/how-it-works` | [`how-it-works-draft.html`](how-it-works-draft.html) | the voice (the only public stall on the internet), the sample-wall story, the practice wall with Art / Price / Age views, free paint as the loud section, and the stall as an autonomous money machine |
| `/toilet` | [`toilet-draft.html`](toilet-draft.html) | the TOILET pitch and its explorers. Its **review notes** (on by default, switch at the top) pin each claim to what the code does today; the app page ships without them |

Both use the `/money` page's tokens: the dark wall scene, Arial at heavy weights, the yellow tag colour,
and monospace for figures. Numbers in the drafts are launch settings or labelled samples. The app reads
the real values from the board and shows a failed read as unavailable, never as zero.

**Who builds from them.** The owner asked on 2 Nov for the public-facing pages to be built by Claude, so
the site keeps one voice and look (`fe-how-it-works`, `fe-toilet-page` in
[`../implementation/`](../implementation/)). Other agents touching the frontend should match these
pages rather than restyle them, and should not copy the drafts' sample numbers into the app.

## Earlier concepts

`concept-preview.html`, `palette-16-proposal.html` and the PNG/JPG files are earlier explorations of the
stall scene and palette.
