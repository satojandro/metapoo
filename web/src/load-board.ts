import type { PixelView, PixelsPageView } from "@shared/types.ts";

/**
 * Walk every `get_pixels` page until the contract says there is no next index.
 *
 * `fetchPage` is injected so unit tests can pretend to be a second client
 * reading what the first client painted, without a live RPC.
 */
export async function loadAllPaintedPixels(
  fetchPage: (fromIndex: number, limit: number) => Promise<PixelsPageView>,
  pageLimit = 256,
): Promise<PixelView[]> {
  const all: PixelView[] = [];
  const seen = new Set<string>();
  let fromIndex = 0;
  let guard = 0;

  while (guard < 10_000) {
    guard += 1;
    const page = await fetchPage(fromIndex, pageLimit);

    for (const pixel of page.pixels) {
      const key = `${pixel.x},${pixel.y}`;
      if (seen.has(key)) {
        throw new Error(
          `get_pixels returned cell (${pixel.x}, ${pixel.y}) more than once across pages.`,
        );
      }
      seen.add(key);
      all.push(pixel);
    }

    if (page.nextFromIndex === null) {
      break;
    }
    if (page.pixels.length === 0) {
      // Avoid an infinite loop if a buggy RPC keeps returning a next index.
      break;
    }
    fromIndex = page.nextFromIndex;
  }

  return all;
}
