# ---------- build ----------
FROM node:22-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
COPY web/package.json web/package-lock.json web/
RUN cd server && npm ci && cd ../web && npm ci
COPY server server
COPY web web
RUN cd web && npm run build \
 && cd ../server && npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-slim
ENV NODE_ENV=production
# Fontes para as artes das amostras (SVG → PNG) com acentos do português
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
# Claude Code (CLAUDE_CODE_ENABLED=true ou AI_PROVIDER=claude-code): a sua assinatura do Claude, sem chave de API.
# Versão fixa e sem atualização automática: para atualizar, troque a versão aqui e reconstrua a imagem.
RUN npm install -g @anthropic-ai/claude-code@2.1.296 && npm cache clean --force \
 && mkdir -p /home/node/.claude && chown node:node /home/node/.claude
ENV DISABLE_AUTOUPDATER=1
WORKDIR /app
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
