# Docker deployment

`frontend-share-sandbox` is deployed as a backend-only service for the xander-lab stack.

## Runtime

- Container and host port: `127.0.0.1:30003:30003`
- Public API prefix after xander-lab-frontend baseURL `/api`: `/studio-api`
- Public preview prefix after xander-lab-frontend baseURL `/api`: `/studio-preview`
- Shared MySQL: host server MySQL, database `xander_lab`
- Shared Redis: existing `relationship-redis` container on external Docker network `xander-network`

## Environment

```bash
cp .env.example .env
vim .env
```

Required values:

- `MYSQL_HOST=host.docker.internal`
- `MYSQL_PORT=3306`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE=xander_lab`
- `REDIS_HOST=relationship-redis`
- `REDIS_PORT=6379`
- `JWT_SECRET`, matching `xander-lab-backend`
- `PREVIEW_URL_PATTERN=https://xander-lab.dsircity.top/api/studio-preview/<projectId>`

Before first deployment, apply `db/schema.sql` to the shared `xander_lab` database.

## Start

```bash
bash scripts/deploy.sh
```

Equivalent command:

```bash
docker compose -p frontend-share-sandbox up -d --build
```

## Nginx

Place these locations before the general `/api/` location:

```nginx
location ^~ /api/studio-api/ {
    proxy_pass http://127.0.0.1:30003/studio-api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /api/studio-preview/ {
    proxy_pass http://127.0.0.1:30003/studio-preview/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Operations

```bash
docker compose -p frontend-share-sandbox ps
docker compose -p frontend-share-sandbox logs -f
docker compose -p frontend-share-sandbox restart
docker compose -p frontend-share-sandbox down
```

Persistent storage:

```text
frontend-share-sandbox-storage -> /app/storage
```
