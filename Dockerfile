FROM node:22-slim

# ffmpeg + yt-dlp ล่าสุด + เครื่องมือคอมไพล์ (สำหรับ @discordjs/opus แบบ native)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "index.js"]
