FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src ./src

# Expose port
EXPOSE 5000

# Start server
CMD ["node", "src/server.js"]

