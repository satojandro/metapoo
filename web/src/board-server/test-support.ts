/** Test doubles for the board server: a scripted WebSocket and a region blob builder. Tests only. */
import { REGION_BYTES, WRITTEN_AT_BYTES, writeBlobPixel, writeWrittenAtNs } from "./region-blob";
import type { SocketFactory } from "./client";

export class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  /** The server accepted the connection. */
  accept(): void { this.readyState = 1; this.onopen?.({} as Event); }
  /** The server pushed a message (raw text, so tests can send u64s unquoted). */
  push(text: string): void { this.onmessage?.({ data: text } as MessageEvent); }
  /** The connection dropped. */
  drop(): void { this.close(); }
}

export function fakeSockets(): { sockets: FakeSocket[]; factory: SocketFactory; last(): FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as ReturnType<SocketFactory>;
    },
    last: () => sockets[sockets.length - 1]!,
  };
}

export interface BlobTile { x: number; y: number; colorIndex: number; ownerId: number; writtenAtNs?: string }

export function buildRegion(tiles: BlobTile[]): { bytes: Uint8Array; writtenAt: Uint8Array } {
  const bytes = new Uint8Array(REGION_BYTES);
  const writtenAt = new Uint8Array(WRITTEN_AT_BYTES);
  for (const t of tiles) {
    writeBlobPixel(bytes, t.x, t.y, t.colorIndex, t.ownerId);
    writeWrittenAtNs(writtenAt, t.x, t.y, t.writtenAtNs ?? "1000");
  }
  return { bytes, writtenAt };
}
