FROM node:22-alpine AS web-build
WORKDIR /src
COPY clients/web/package.json clients/web/package-lock.json ./clients/web/
RUN npm ci --prefix clients/web
COPY clients/web ./clients/web
RUN npm run --prefix clients/web build

FROM golang:1.24-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY db ./db
COPY internal ./internal
COPY --from=web-build /src/internal/httpapi/web/dist ./internal/httpapi/web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ttsync ./cmd/ttsync \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 go test -c -tags=integration -o /out/postgres-integration.test ./internal/platform/postgres

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=go-build /out/ttsync /out/migrate /out/postgres-integration.test /app/
EXPOSE 8080
CMD ["/app/ttsync"]
