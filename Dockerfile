FROM node:20-slim

# Install Python, FFmpeg, and pip
RUN apt-get update && \
    apt-get install -y python3 python3-pip python-is-python3 ffmpeg curl && \
    apt-get clean

# Install edge-tts (Microsoft free TTS)
RUN pip install edge-tts --break-system-packages

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
