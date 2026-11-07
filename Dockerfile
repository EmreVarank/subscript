# Production Dockerfile for liscript (Node.js 22 Alpine)
FROM node:22-alpine

# Güvenlik ve çalışma dizini
WORKDIR /app

# Ortam değişkenleri
ENV NODE_ENV=production
ENV PORT=8080

# Bağımlılık dosyalarını kopyala
COPY package*.json ./

# Sadece üretim bağımlılıkları (sıfır bağımlılık olduğu için hızlı geçer)
RUN npm install --omit=dev --ignore-scripts

# Tüm uygulama dosyalarını kopyala
COPY . .

# Kalıcı veri dizinini oluştur
RUN mkdir -p /app/data

# Non-root kullanıcı ile çalıştır
USER node

# Port expose
EXPOSE 8080

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/clips || exit 1

# Sunucuyu başlat
CMD ["node", "server.js"]
