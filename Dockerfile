# Use the current Node.js LTS image
FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy package files first so dependency install is cached across builds
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the application (.dockerignore excludes .env, .git, node_modules, reports/)
COPY . .

# The web UI server (server/index.js) listens on process.env.PORT, default 3001 — see .env
EXPOSE 3001

# Serve the web UI. Live credentials/URLs are supplied at runtime via .env (docker-compose's
# env_file), never baked into the image — see .dockerignore.
CMD ["node", "server/index.js"]
