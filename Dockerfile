FROM node:lts-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --ignore-scripts

# Copy the remaining source code
COPY . .

# Build the project using TypeScript
RUN npm run build

# Expose any ports if required (the MCP server communicates via stdio, so port mapping may not be needed)
EXPOSE 3000

# Set the default command to run the server
CMD ["node", "dist/index.js"]