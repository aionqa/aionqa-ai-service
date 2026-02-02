FROM node:20-alpine

WORKDIR /app

# Install wget for health checks
RUN apk add --no-cache wget

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY src ./src

# Expose port
EXPOSE 5000

# Start server
CMD ["node", "src/server.js"]



