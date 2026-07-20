# ── Stage 1: deps ────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production deps only (skip playwright, nodemon)
RUN npm install --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────
FROM node:22-slim AS runtime

# Install Chromium system libraries required by whatsapp-web.js (Puppeteer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV XDG_CONFIG_HOME=/tmp
ENV XDG_CACHE_HOME=/tmp

# Create non-root user BEFORE copying files so no chown -R is needed
RUN groupadd -r botuser && useradd -r -g botuser -G audio,video botuser \
    && mkdir -p /app/whatsapp_auth

WORKDIR /app

# Copy with correct ownership from the start — avoids slow recursive chown
COPY --from=deps --chown=botuser:botuser /app/node_modules ./node_modules
COPY --chown=botuser:botuser . .

USER botuser

EXPOSE 3000

# Clean up any leftover Chromium locks on startup before running node
CMD sh -c 'find /app/whatsapp_auth -name "SingletonLock" -delete 2>/dev/null || true && node src/index.js'
