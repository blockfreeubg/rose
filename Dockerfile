FROM node:22-bookworm-slim
ARG SCRCPY_VERSION=3.1
RUN apt-get update && apt-get install -y --no-install-recommends adb unzip ca-certificates curl \
 && curl -fsSL -o /app-scrcpy-server https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION} \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
RUN mv /app-scrcpy-server /app/scrcpy-server
ENV SCRCPY_VERSION=${SCRCPY_VERSION} APK_DIR=/app/apks FILE_DIR=/app/files
EXPOSE 8080
CMD ["node", "server/index.js"]
