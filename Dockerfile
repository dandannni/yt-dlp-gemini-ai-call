FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip python-is-python3 ffmpeg curl && \
    apt-get clean

# Install edge-tts properly
RUN pip3 install edge-tts --break-system-packages

# Verify edge-tts is installed
RUN edge-tts --version

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Verify yt-dlp is installed
RUN yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
