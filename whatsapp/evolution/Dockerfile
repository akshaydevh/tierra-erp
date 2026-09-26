FROM node:24-alpine AS builder

ARG EVOLUTION_REPOSITORY=https://github.com/EvolutionAPI/evolution-api.git
ARG EVOLUTION_REVISION=cd800f2976e1e5b682fbf86a01ee4d85ae61f370

RUN apk add --no-cache bash curl ffmpeg git openssl wget

WORKDIR /evolution

RUN git init . && \
    git remote add origin "${EVOLUTION_REPOSITORY}" && \
    git fetch --depth 1 origin "${EVOLUTION_REVISION}" && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "${EVOLUTION_REVISION}"

COPY patches/0001-native-contact-and-group-mentions.patch /tmp/evolution-mentions.patch
COPY patches/0002-roundup-url-button.patch /tmp/evolution-url-button.patch
COPY patches/0003-interactive-url-button.patch /tmp/evolution-interactive-button.patch
COPY patches/0004-outgoing-message-status.patch /tmp/evolution-outgoing-status.patch
RUN git apply --check /tmp/evolution-mentions.patch && \
    git apply /tmp/evolution-mentions.patch && \
    git apply --check /tmp/evolution-url-button.patch && \
    git apply /tmp/evolution-url-button.patch && \
    git apply --check /tmp/evolution-interactive-button.patch && \
    git apply /tmp/evolution-interactive-button.patch && \
    git apply --check /tmp/evolution-outgoing-status.patch && \
    git apply /tmp/evolution-outgoing-status.patch

RUN npm ci --silent
RUN cp .env.example .env
RUN chmod +x ./Docker/scripts/* && dos2unix ./Docker/scripts/*
RUN ./Docker/scripts/generate_database.sh
RUN npm run build

FROM node:24-alpine AS final

ARG EVOLUTION_REVISION=cd800f2976e1e5b682fbf86a01ee4d85ae61f370

RUN apk add --no-cache bash ffmpeg openssl tzdata

LABEL org.opencontainers.image.source="https://github.com/EvolutionAPI/evolution-api" \
      org.opencontainers.image.revision="${EVOLUTION_REVISION}" \
      org.opencontainers.image.title="Tierra Evolution API"

ENV TZ=Asia/Kolkata
ENV DOCKER_ENV=true

WORKDIR /evolution

COPY --from=builder /evolution/package.json ./package.json
COPY --from=builder /evolution/package-lock.json ./package-lock.json
COPY --from=builder /evolution/node_modules ./node_modules
COPY --from=builder /evolution/dist ./dist
COPY --from=builder /evolution/prisma ./prisma
COPY --from=builder /evolution/manager ./manager
COPY --from=builder /evolution/public ./public
COPY --from=builder /evolution/.env.example ./.env
COPY --from=builder /evolution/Docker ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js
COPY --from=builder /evolution/tsup.config.ts ./tsup.config.ts

EXPOSE 8080

ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod"]
