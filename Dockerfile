# Use Node.js as the base image
FROM node:20-slim

# 🛠️ Install System Dependencies
# Added 'python-is-python3' to fix the "No JS runtime" warning
RUN apt-get update && \
    apt-get install -y python3 python3-pip python-is-python3 ffmpeg curl && \
    apt-get clean

# 📥 Install yt-dlp (Latest Version)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app code
COPY . .

# Expose the port for Render
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
