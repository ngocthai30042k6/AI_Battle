FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev
COPY shared ./shared
COPY server ./server
WORKDIR /app/server
EXPOSE 8787
CMD ["npm", "start"]
