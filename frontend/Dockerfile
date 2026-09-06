# ─── 构建阶段：与 package.json build 一致（tsc -b && vite build）───
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# tsconfig 工程引用（tsc -b 需要 tsconfig.node.json 等），.dockerignore 已排除 node_modules/dist
COPY . .
RUN npm run build

# ─── 运行阶段：nginx 托管静态产物（SPA fallback + /api + /socket.io 反代见 nginx.conf）───
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
