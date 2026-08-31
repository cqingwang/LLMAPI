FROM scratch

COPY .dev/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY .dev/tmp /tmp
WORKDIR /app
COPY .dev/axonhub /app/axonhub

EXPOSE 8090
ENTRYPOINT ["/app/axonhub"]
