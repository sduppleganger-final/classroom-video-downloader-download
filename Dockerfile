FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
  HOSTED_MODE=1 \
  PORT=3000 \
  PYTHON_BIN=python3 \
  DOWNLOADS_DIR=/tmp/classroom-video-downloads

EXPOSE 3000

CMD ["node", "server.js"]
