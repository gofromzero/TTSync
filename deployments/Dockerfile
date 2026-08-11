FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS web-build
WORKDIR /src
COPY clients/web/package.json clients/web/package-lock.json ./clients/web/
RUN npm ci --prefix clients/web
COPY clients/web ./clients/web
RUN npm run --prefix clients/web build

FROM golang:1.25-alpine@sha256:56961d79ea8129efddcc0b8643fd8a5416b4e6228cfd477e3fd61deb2672c587 AS go-build
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

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS runtime
WORKDIR /app
RUN addgroup -S ttsync && adduser -S -D -H -s /sbin/nologin -G ttsync ttsync
COPY --from=go-build /out/ttsync /out/migrate /out/postgres-integration.test /app/
USER ttsync:ttsync
EXPOSE 8080
CMD ["/app/ttsync"]
