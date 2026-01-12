FROM node:18-alpine

WORKDIR /app

# Instalar dependencias de build para sqlite3 si es necesario
# (better-sqlite3 a veces requiere python/make/g++, pero la imagen alpine suele usarse con prebuilds o instalando lo necesario)
RUN apk add --no-cache python3 make g++

COPY package.json .
RUN npm install --production

COPY server.js .
# Crear directorio para la DB
RUN mkdir data

EXPOSE 3000

CMD ["npm", "start"]
