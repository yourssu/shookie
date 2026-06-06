FROM node:20-slim

WORKDIR /app

# Enable corepack for yarn
RUN corepack enable

# Copy workspace root files
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./

# Copy package files
COPY shookie/package.json shookie/package.json
COPY database/package.json database/package.json

# Install dependencies
RUN yarn install --immutable

# Copy source
COPY shookie/ shookie/
COPY database/ database/

# Build
RUN yarn workspace database build
RUN yarn workspace shookie build

# Run
WORKDIR /app/shookie
CMD ["node", "dist/index.js"]
