FROM alpine:3.24.2
RUN apk add --no-cache openssl
COPY init.sh /usr/local/bin/init.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/init.sh"]
