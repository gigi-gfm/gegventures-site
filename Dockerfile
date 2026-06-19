# Gegventures site — production container.
# Works on any container host (Railway, Fly.io, Cloud Run, etc.).
FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app.
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# ANTHROPIC_API_KEY must be provided at runtime as an environment variable.
CMD ["node", "server.js"]
