# Use a lightweight Node.js image
FROM node:20-slim

# 🛠️ Install System Dependencies (Python, FFmpeg, Pip)
# We need these for yt-dlp to work
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg curl && \
    apt-get clean

# 📥 Install yt-dlp (The tool that downloads music)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# Set up the app directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
