FROM node:24-alpine

WORKDIR /app

# 先装依赖，利用层缓存
COPY prototype/package*.json ./
RUN npm ci --omit=dev

COPY prototype/ ./

ENV NODE_ENV=production \
    SAFE_OFFICE_HOST=0.0.0.0 \
    PORT=7812

EXPOSE 7812

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7812/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.cjs"]
