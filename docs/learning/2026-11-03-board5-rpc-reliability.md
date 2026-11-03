# Board5 browser RPC throttling — 3 November 2026

The live Vercel build `29b30fb` used board5.metapoo-player1.testnet and
rpc.testnet.fastnear.com. In the owner's connected Brave session, DevTools showed
HTTP 429 responses without Access-Control-Allow-Origin; JavaScript consequently
reported Failed to fetch. Both board polling and auxiliary balance/revenue reads
were affected while the paint UI reported Price unavailable.

Direct reads against board3 or another RPC did not reproduce this browser failure.
Always verify the deployed board, endpoint, build and browser origin first.

The frontend now shares a bounded, paced, in-flight-deduplicating read transport
across board, pricing, revenue and paint-wallet reads. It backs off unhealthy
endpoints, including browser-hidden transport failures, and can try a network-specific
backup. It never accepts transaction broadcasts, caches no completed prices or
balances, and preserves the original account, arguments and pinned block on fallback.
A pointer sweep retains only its latest waiting tile. Existing hidden-tab suppression
and exponential board-poll backoff are preserved. Balance failures are distinguished
from price failures; recovering a price does not claim a failed balance recovered.

The regression `reads board5 through a backup when the primary rate limits` failed
before the change with RPC HTTP 429. Transport tests cover cooldown, independent
subscribers, read priority, fresh subsequent reads and rejection of broadcasts.
Controller tests cover bounded hover traffic and error recovery.

This is a frontend reliability change, not proof of a successful paid paint.
After automatic Vercel deployment, verify board5 in Brave: single tile, stroke,
fresh matching pixel reads and a credit decrease for a paid paint. Free paints must
not decrease credits. Contract code, session authority and signing are unchanged.
