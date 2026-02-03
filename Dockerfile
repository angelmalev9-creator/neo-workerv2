# NEO Worker v4 - Hot Sessions
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (use npm install since we don't have lock file)
RUN npm install

# Install TypeScript globally for build
RUN npm install -g typescript

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start
CMD ["npm", "start"]
