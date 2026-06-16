# Mastermind — demo image: orchestration backend + dashboard UI.
# Node 22 (matches the bundled undici 6, so the provider's streaming dispatcher works).
# Backend runs via tsx; workspace deps and the frontend are built first.
FROM node:22
WORKDIR /app
COPY . .
RUN npm install
# Workspace packages are published from dist/ (excluded from the repo) — build them.
RUN npm run build --workspace=packages/shared \
 && npm run build --workspace=@mastermind/codebase-search
# Build the dashboard with the demo API key baked in (production build → no mock,
# talks to the real backend same-origin, auto-authenticates with demo-key).
RUN VITE_API_KEY=demo-key npm run build:frontend
RUN mkdir -p /data/agents /data/shared-memory
ENV MASTERMIND_CONFIG=/app/config/mastermind.docker.yml
EXPOSE 3000
# The backend serves packages/frontend/dist (SPA) alongside /api and the WebSocket.
CMD ["npx", "tsx", "packages/backend/src/index.ts"]
