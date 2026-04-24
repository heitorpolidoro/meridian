# Stage 1: Build the frontend
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Final image
FROM node:24-slim

WORKDIR /app

# Install dependencies for Gemini CLI if needed and any other system deps
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install gemini-cli globally as it is used by server.ts
RUN npm install -g @google/gemini-cli

COPY package*.json ./
RUN npm ci --omit=dev

# Copy only the necessary files for the runtime
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/server.ts ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/.meridian ./.meridian

# Create a volume for meridian settings and project data
VOLUME ["/app/.meridian", "/app/projects"]

EXPOSE 3000

ENV NODE_ENV=production

CMD ["npm", "start"]
