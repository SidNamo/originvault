FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache exiftool su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/originvault-entrypoint
EXPOSE 4000
ENTRYPOINT ["originvault-entrypoint"]
CMD ["node", "dist/index.js"]
