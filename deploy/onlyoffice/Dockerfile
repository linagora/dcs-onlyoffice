FROM onlyoffice/documentserver:9.4.0.1@sha256:3ab6ebc7c605e5a32b7ae3ff19daed4925090245acc8100ce2230bd766c88212

# Every editor loads common/Analytics.js as it starts: a Google Analytics
# wrapper that only acts when the editor's configuration gives it an id, which
# this stack never does. Ad blockers block that name, and the editor then never
# starts, so the editors load the same file under another name; any name
# without "analytics" would do. nginx serves the precompressed copies of these
# files, so they are compressed again. No released version of ONLYOFFICE is
# free of the module yet: only its development branch dropped it.
ARG APPS=/var/www/onlyoffice/documentserver/web-apps/apps
ARG BLOCKED=common/Analytics
ARG RENAMED=common/EditorEvents
RUN cd "$APPS" \
  && cp "$BLOCKED.js" "$RENAMED.js" \
  && gzip --best --keep --force "$RENAMED.js" \
  && for bootstrap in $(grep -rl --include=app.js "'$BLOCKED'" .); do \
    sed -i "s|'$BLOCKED'|'$RENAMED'|" "$bootstrap" && gzip --best --keep --force "$bootstrap" || exit 1; \
  done \
  && grep -rlq --include=app.js "'$RENAMED'" . \
  && ! grep -rIlq "$BLOCKED" .
