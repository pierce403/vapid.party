FROM golang:1.26.0-alpine3.23 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/xmtp-listener .

FROM alpine:3.23

RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 listener \
    && adduser -S -D -H -u 10001 -G listener listener
COPY --from=build --chown=listener:listener /out/xmtp-listener /usr/local/bin/xmtp-listener

USER listener:listener
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/livez || exit 1

ENTRYPOINT ["/usr/local/bin/xmtp-listener"]
