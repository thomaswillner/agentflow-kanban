# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AgentFlow — Docker Image
# Lightweight Node.js container for local deployment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FROM node:22-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-fund --no-audit

# Copy application files
COPY server.js kanban.html ./

# Create data directory (will be overridden by volume mount)
RUN mkdir -p /app/data

# Expose default port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Run as non-root user for security
RUN addgroup -S agentflow && adduser -S agentflow -G agentflow
RUN chown -R agentflow:agentflow /app
USER agentflow

# Start the server
CMD ["node", "server.js"]
