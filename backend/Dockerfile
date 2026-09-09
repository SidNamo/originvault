FROM node:24-alpine3.23 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine3.23
RUN apk add --no-cache \
    exiftool \
    imagemagick \
    imagemagick-heic \
    imagemagick-jp2 \
    imagemagick-jpeg \
    imagemagick-jxl \
    imagemagick-openexr \
    imagemagick-raw \
    imagemagick-tiff \
    imagemagick-webp \
    poppler-utils \
    su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY imagemagick-policy.xml /etc/ImageMagick-7/policy.xml
RUN magick -list format | grep -Eq '^[[:space:]]*HEIC[[:space:]]+HEIC[[:space:]]+r' \
    && magick -list format | grep -Eq '^[[:space:]]*JP2[*]?[[:space:]]+JP2[[:space:]]+r' \
    && magick -list format | grep -Eq '^[[:space:]]*JXL[*]?[[:space:]]+JXL[[:space:]]+r' \
    && magick -list format | grep -Eq '^[[:space:]]*DNG[[:space:]]+DNG[[:space:]]+r' \
    && magick -list format | grep -Eq '^[[:space:]]*WEBP[*]?[[:space:]]+WEBP[[:space:]]+[rw-]*w'
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/originvault-entrypoint
EXPOSE 4000
ENTRYPOINT ["originvault-entrypoint"]
CMD ["node", "dist/index.js"]
