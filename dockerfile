# Debian (Bullseye)
FROM node:18-bullseye

# Update System
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    libsqlite3-dev \
    zlib1g-dev \
    gdal-bin \
    && rm -rf /var/lib/apt/lists/*

# TIPPECANOE : geojson converter
WORKDIR /tmp
RUN git clone https://github.com/felt/tippecanoe.git \
    && cd tippecanoe \
    && make -j \
    && make install \
    && cd .. \
    && rm -rf tippecanoe

# Setup Aplikasi Node
WORKDIR /app

# cp package json
COPY package*.json ./
RUN npm install

# Copy all
COPY . .

# Buat folder uploads untuk penampungan sementara
RUN mkdir -p uploads

# Buka port 3000
EXPOSE 8001

CMD ["node", "src/server.js"]
