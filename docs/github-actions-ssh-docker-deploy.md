# GitHub Actions 自动部署 Docker 项目：从零配置 SSH 发布

本文介绍如何让 GitHub Actions 在推送 `main` 分支后，通过 SSH 登录服务器，拉取最新代码并执行 Docker Compose 部署。

适用于已经可以在服务器上通过 Docker Compose 运行的 Node.js、Java、Python 等后端项目。本文示例中的域名、IP、路径和密钥均为占位符，请替换成自己的值。

## 最终流程

```text
本地 git push main
        ↓
GitHub Actions
        ↓ 使用 DEPLOY_SSH_KEY 登录服务器
服务器拉取 main 最新代码
        ↓
bash scripts/deploy.sh
        ↓
docker compose up -d --build
```

## 1. 编写服务器部署脚本 `scripts/deploy.sh`

在项目中创建 `scripts/deploy.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="your-app-name"

# 脚本不受从哪个目录调用的影响，始终切换到项目根目录。
cd "$(dirname "$0")/.."

# .env 只保存在服务器，不要提交到 Git。
if [ ! -f ".env" ]; then
  echo "Missing .env. Create it from .env.example and fill production values first."
  exit 1
fi

docker compose -p "$APP_NAME" up -d --build
docker compose -p "$APP_NAME" ps
```

在服务器的项目目录中，首次执行一次确认脚本可用：

```bash
bash scripts/deploy.sh
```

> 不要把 `.env`、私钥或密码写进 `deploy.sh`，应只在服务器保存 `.env`。

## 2. 编写 GitHub Actions 工作流

创建 `.github/workflows/deploy.yml`：

```yml
name: Deploy

on:
  push:
    branches:
      - main

permissions:
  contents: read

concurrency:
  group: production-deploy
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Configure SSH
        env:
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          mkdir -p ~/.ssh
          printf '%s\n' "$DEPLOY_SSH_KEY" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts

      - name: Pull source and deploy
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
          DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}
        run: |
          ssh -o StrictHostKeyChecking=yes "$DEPLOY_USER@$DEPLOY_HOST" "
            set -e
            cd '$DEPLOY_PATH'
            git fetch --prune origin main
            git checkout main
            git reset --hard origin/main
            bash scripts/deploy.sh
            docker image prune -f
          "
```

`concurrency` 会避免多次推送同时部署；后一轮部署会取消尚未完成的旧任务。

## 3. 电脑 PowerShell：生成部署密钥

在自己的电脑 PowerShell 执行。请使用专门的部署密钥，不要使用个人日常 SSH 私钥：

```powershell
ssh-keygen -t ed25519 -C "github-actions-deploy" -f "$HOME\.ssh\github_actions_deploy"
```

密码提示可以直接按两次回车，保持为空。命令会生成：

```text
~/.ssh/github_actions_deploy       # 私钥：仅放入 GitHub Secret
~/.ssh/github_actions_deploy.pub   # 公钥：放到服务器
```

## 4. 电脑：获取公钥

```powershell
Get-Content "$HOME\.ssh\github_actions_deploy.pub"
```

复制完整的一行 `ssh-ed25519 ... github-actions-deploy`。

## 5. 服务器：添加公钥并确定登录用户

先用你现有的方式登录服务器，执行：

```bash
whoami
```

输出的用户名就是稍后 GitHub Secret `DEPLOY_USER` 应填的值。例如，输出为 `deploy`，那么：

```text
DEPLOY_USER=deploy
```

请以这个目标用户执行下面命令，将第 4 步复制的完整公钥替换进去：

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo 'ssh-ed25519 此处粘贴完整公钥 github-actions-deploy' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

对应关系如下：

| 公钥写入位置 | `DEPLOY_USER` |
|---|---|
| `/root/.ssh/authorized_keys` | `root` |
| `/home/deploy/.ssh/authorized_keys` | `deploy` |
| `/home/ubuntu/.ssh/authorized_keys` | `ubuntu` |

> 不建议把私钥放到服务器；服务器只保存公钥。若使用非 root 用户，该用户还必须拥有项目目录的读写权限和 Docker 操作权限。

## 6. 电脑：验证密钥是否正确

将用户名和 IP 替换为自己的值：

```powershell
ssh -i "$HOME\.ssh\github_actions_deploy" -o IdentitiesOnly=yes deploy@203.0.113.10
```

能正常登录才继续配置 GitHub。若失败，优先检查：公钥是否写入了正确用户的 `authorized_keys`，以及 `DEPLOY_USER` 是否与该用户一致。

## 7. 服务器：确认项目目录和 Git 远程

在服务器执行：

```bash
cd /srv/your-app
git remote -v
```

工作流会执行 `git fetch origin main`，因此 `origin` 必须是正确的 GitHub 仓库。公开仓库可以这样设置：

```bash
git remote set-url origin https://github.com/your-org/your-repo.git
git fetch origin main
```

若仓库是私有仓库，服务器还需要单独获得读取该仓库的权限，例如为服务器配置只读 Deploy Key。GitHub Actions 用来登录服务器的密钥，与服务器用来拉取私有仓库的密钥是两件事。

## 8. 电脑：获取服务器主机指纹

```powershell
ssh-keyscan -H 203.0.113.10
```

复制全部以 `|1|` 开头的输出行，不复制 `#` 开头的注释行。这些内容将作为 `DEPLOY_KNOWN_HOSTS`，用于确认连接的确实是目标服务器。

## 9. 电脑：获取私钥

```powershell
Get-Content -Raw "$HOME\.ssh\github_actions_deploy"
```

复制从 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----` 的完整内容。

> 私钥只允许保存在自己的电脑和 GitHub Secret 中。不要发送给他人、不要提交到 Git，也不要贴到聊天记录或日志。

## 10. GitHub：配置 Actions Secrets

进入 GitHub 仓库：**Settings → Secrets and variables → Actions → New repository secret**，新增以下 Secret：

| 名称 | 示例值 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | `203.0.113.10` | 服务器 IP 或域名 |
| `DEPLOY_USER` | `deploy` | 第 5 步确认的服务器登录用户 |
| `DEPLOY_PATH` | `/srv/your-app` | 服务器项目根目录 |
| `DEPLOY_SSH_KEY` | 完整私钥 | 第 9 步的输出 |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan` 输出 | 第 8 步复制的全部指纹行 |

## 11. 推送并查看部署日志

提交并推送工作流和部署脚本：

```bash
git add scripts/deploy.sh .github/workflows/deploy.yml
git commit -m "ci: add automatic deployment"
git push origin main
```

在 GitHub 仓库顶部点击 **Actions**，选择 `Deploy`，打开最新一次运行记录。

全部步骤显示绿色即表示：SSH 登录、代码拉取、Docker 构建和容器重启都成功完成。

也可在服务器验证：

```bash
cd /srv/your-app
docker compose -p your-app-name ps
docker compose -p your-app-name logs --tail=100
```

## 常见问题

### `Permission denied (publickey,password)`

通常是 `DEPLOY_USER` 填错，或者公钥写进了另一个用户的 `authorized_keys`。先在电脑用第 6 步命令验证同一把密钥和同一用户名。

### Actions 成功，但服务器不是最新代码

检查服务器项目目录中的 `git remote -v`。工作流拉取的是 `origin/main`，它必须指向正确的 GitHub 仓库。

### 非 root 用户无法执行 Docker

把部署用户加入 Docker 组后重新登录：

```bash
sudo usermod -aG docker deploy
```

### 私钥泄露

立即从 GitHub 删除对应 Secret，从服务器的 `authorized_keys` 删除对应公钥，重新生成一对密钥并按本文流程重新配置。
