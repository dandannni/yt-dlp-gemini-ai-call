FROM node:20-slim

# Install system dependencies: Python, pip, FFmpeg, curl, and build-essential
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl build-essential && \
    apt-get clean

# Install free Edge TTS, yt-dlp python dependencies, and curl-cffi for browser TLS impersonation
RUN pip config set global.break-system-packages true && \
    pip install --no-cache-dir -U edge-tts "yt-dlp[default]" curl-cffi

# Install latest yt-dlp nightly binary
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
