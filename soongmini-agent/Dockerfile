FROM node:20-slim

WORKDIR /app

# Enable corepack for yarn
RUN corepack enable

# Copy workspace root files
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./

# Copy package files
COPY soongmini-agent/package.json soongmini-agent/package.json
COPY database/package.json database/package.json

# Install dependencies
RUN yarn install --immutable

# Copy source
COPY soongmini-agent/ soongmini-agent/
COPY database/ database/

# Build
RUN yarn workspace database build
RUN yarn workspace soongmini-agent build

# Run
WORKDIR /app/soongmini-agent
CMD ["node", "dist/index.js"]
