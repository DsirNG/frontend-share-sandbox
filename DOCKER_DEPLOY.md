# Docker 部署说明

## 1. 准备环境变量

```bash
cp .env.example .env
vim .env
```

至少确认这些值：

- `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`
- `REDIS_HOST` / `REDIS_PORT`
- `JWT_SECRET`：必须与 Java 后端一致
- `PREVIEW_URL_PATTERN`：生产环境建议改成真实预览域名

如果 Redis 安装在服务器宿主机上，`.env.example` 中的 `REDIS_HOST=host.docker.internal` 可以配合 `docker-compose.yml` 的 `extra_hosts` 使用。

## 2. 启动服务

```bash
bash scripts/deploy.sh
```

等价命令：

```bash
docker compose -p frontend-share-sandbox up -d --build
```

服务名、容器名、镜像名：

- Compose 项目名：`frontend-share-sandbox`
- 容器名：`frontend-share-sandbox`
- 镜像名：`frontend-share-sandbox:latest`

端口映射：

```text
30001:30001
```

## 3. 常用运维命令

```bash
docker compose -p frontend-share-sandbox ps
docker compose -p frontend-share-sandbox logs -f
docker compose -p frontend-share-sandbox restart
docker compose -p frontend-share-sandbox down
```

`storage` 目录使用 Docker volume 持久化：

```text
frontend-share-sandbox-storage -> /app/storage
```
