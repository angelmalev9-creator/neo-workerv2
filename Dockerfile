# NEO Worker v4 - Hot Sessions
FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Minimal system deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Expose port
EXPOSE 3000

# Start
CMD ["node", "dist/worker.js"]
