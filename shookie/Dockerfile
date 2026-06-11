FROM node:20-slim

WORKDIR /app

# Install git, gh CLI, and CA certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    update-ca-certificates && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Enable corepack for yarn
RUN corepack enable

# Pre-configure git for bot commits
RUN git config --global user.email "shookie-bot@yourssu.com" && \
    git config --global user.name "Shookie Bot" && \
    git config --global credential.helper '!gh auth git-credential'

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
