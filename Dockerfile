FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=30003

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p storage/uploads storage/projects storage/previews \
  && chown -R node:node /app

USER node

EXPOSE 30003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:' + (process.env.PORT || 30003) + '/health', res => process.exit(res.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["npm", "start"]
