# Docker deployment

`frontend-share-sandbox` is deployed as a backend-only service for the xander-lab stack.

## Runtime

- Container and host port: `127.0.0.1:30003:30003`
- Public API prefix after xander-lab-frontend baseURL `/api`: `/studio-api`
- Public preview host pattern: `<projectId>.preview.xander-lab.dsircity.top`
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
- `PREVIEW_URL_PATTERN=https://<projectId>.preview.xander-lab.dsircity.top/`

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

Place this location before the general `/api/` location on `xander-lab.dsircity.top`:

```nginx
location ^~ /api/studio-api/ {
    proxy_pass http://127.0.0.1:30003/studio-api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Preview pages are served from wildcard subdomains:

```nginx
server {
    listen 443 ssl http2;
    server_name *.preview.xander-lab.dsircity.top;

    location / {
        proxy_pass http://127.0.0.1:30003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The wildcard DNS record and TLS certificate must both cover `*.preview.xander-lab.dsircity.top`.

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
