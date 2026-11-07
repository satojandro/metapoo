# Build from the repo root (the palette is read from shared/board.json at compile time):
#   docker build -f ops/board-server/Dockerfile -t metapoo-board-server .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY shared/board.json shared/board.json
COPY ops/board-server ops/board-server
RUN cd ops/board-server && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/ops/board-server/target/release/indexer /usr/local/bin/indexer
COPY --from=build /src/ops/board-server/target/release/server /usr/local/bin/server
CMD ["server"]
