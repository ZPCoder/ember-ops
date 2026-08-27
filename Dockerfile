# syntax=docker/dockerfile:1.7

FROM ghcr.io/cirruslabs/flutter:3.41.6 AS flutter-build
WORKDIR /src/flutter_app

COPY flutter_app/pubspec.yaml flutter_app/pubspec.lock ./
RUN flutter pub get --enforce-lockfile

COPY flutter_app/ ./
RUN flutter build web --release --no-web-resources-cdn


FROM dart:3.11.4-sdk AS room-server-build
WORKDIR /src

COPY server/multiplayer_server.dart ./server/multiplayer_server.dart
RUN mkdir -p /out \
    && dart compile exe server/multiplayer_server.dart -o /out/multiplayer-server


FROM nginx:1.28.0-alpine3.21 AS web

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=flutter-build --chown=nginx:nginx /src/flutter_app/build/web/ /usr/share/nginx/html/

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]

CMD ["nginx", "-g", "daemon off;"]


FROM gcr.io/distroless/cc-debian12:nonroot AS room-server

WORKDIR /app
COPY --from=room-server-build --chown=nonroot:nonroot /out/multiplayer-server /app/multiplayer-server

USER nonroot:nonroot
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/app/multiplayer-server", "--health-check", "8787"]

ENTRYPOINT ["/app/multiplayer-server"]
CMD ["8787"]
