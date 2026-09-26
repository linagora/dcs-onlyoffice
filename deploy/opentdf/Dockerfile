# The platform image is distroless: it has no shell and no HTTP client to run a
# health check with. A static BusyBox brings wget.
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS probe

FROM registry.opentdf.io/platform:v0.27.0@sha256:4f35e6a10af23a2aaeb53133afc28ed8c3a3f23407701e002358231775c5318a
COPY --from=probe /bin/busybox /usr/local/bin/busybox
