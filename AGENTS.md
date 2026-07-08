# Xander Lab 协作规范

## 项目架构

Xander Lab 由三个服务组成：

| 服务 | 技术栈 | 端口 | 路径 |
|---|---|---|---|
| 前端 | React 19 + Vite 7 + Tailwind CSS 4 | 5173 (dev) | 当前仓库 |
| Java 后端 | Spring Boot 3.2.1 + MyBatis-Plus + MySQL + Redis | 30002 | xander-lab-backend |
| Node 工作室 | Express.js + MySQL + Redis + JWT | 3010 | frontend-share-sandbox |

三个服务共享同一个 MySQL 数据库（xander_lab）和 Redis 实例。

## 统一错误响应格式

所有后端（Java / Node）的错误响应必须使用统一格式：

```json
{ "code": 401, "message": "未登录或登录已过期", "data": null }
```

- Java 后端使用 `Result.unauthorized(message)` / `Result.error(code, message)` 等
- Node 工作室使用 `sendError(res, code, message)` 辅助函数
- 401 消息统一为「未登录或登录已过期」，不区分未携带 token 和 token 过期

## 鉴权体系

- JWT 多设备登录：每次登录生成独立 token，互不影响
- Redis 存储：`login:token:{accessToken}` → userId（TTL 2h），`login:user_tokens:{userId}` → Set\<token\>
- 路径鉴权：仅写操作（上传、分享、导出等）需要登录，GET 请求默认公开
- Node 工作室与 Java 后端共享同一个 JWT 密钥和 Redis，token 互通
- 前端 http.js 拦截器处理 401：先尝试无感刷新，刷新失败则清除 token + 触发 auth:logout 事件

## 前端 HTTP 请求

**所有 API 请求必须基于 `src/api/http.js` 封装的 axios 实例**，不允许另建 axios 实例或使用原生 fetch。

- 平台接口（Java 后端）：使用 `http.js` 导出的 `get/post/put/del` 等方法，baseURL 为 `/api`
- 工作室接口（Node 服务）：同样使用 `http.js` 导出的实例，通过 `config.baseURL = ''` 覆盖基础路径，如：
  ```js
  import { get } from '@api/http';
  get('/studio-api/projects', {}, { baseURL: '' });
  ```
- 禁止为不同服务创建独立的 axios 实例（如 studioHttp.js），统一走 http.js 的拦截器，确保鉴权、toast、重试等逻辑一致

## 前端 Toast 提示

- 全局 toast 桥接：App.jsx 的 `ToastBridge` 注册 `window.__toast`
- http.js 拦截器直接按状态码弹 toast：
  - 401 → `warning`
  - 5xx / 网络错误 → `error`
  - 4xx → `error`
  - 业务错误（code !== 200/0）→ `error`
- 特定请求可传 `config._silent = true` 静默 toast
- 不要使用事件监听（auth:logout）来弹 toast，直接在拦截器层处理

## 国际化（i18n）

项目支持 6 种语言：zh / en / fr / ja / ru / vi

**新增任何 i18n key 时，必须同时更新全部 6 个语言文件**（`src/locales/*.js`），不能只改一两种。

## 路由结构

- MainLayout 下的路由：首页、组件、博客列表、工作室首页
- 独立路由（不在 MainLayout 内）：studio/project、studio/component、studio/compiler、components/share、blog/publish
- 全局处理逻辑（如 toast、鉴权提示）必须放在 App.jsx 层级，不能放在 MainLayout 中

## 本地开发环境

- JDK 17：`C:\jdk-17.0.2`（已加入用户 PATH）
- Maven 3.9.9：本地安装
- Redis：localhost:6379
- MySQL：远程 101.33.246.103:3306，数据库 xander_lab
- Java 后端本地配置：`application-local.yml`（自动加载，不提交 git）
- 前端预览 URL 模式：通过 `PREVIEW_URL_PATTERN` 环境变量配置

## Git 提交要求

- 每次完成代码编辑并通过必要验证后，提交到本地 Git。
- 提交标题必须使用中文，并以 `【dxd】` 作为前缀。
- 提交信息必须包含 title 和 desc 描述。
- 推荐格式：

```text
【dxd】中文提交标题

desc: 简要说明本次修改内容、原因或影响范围。
```

- 不要把无关的本地改动一起提交，例如本地环境配置、用户临时修改或与当前任务无关的文件。
- 如果工作区已有用户改动，提交前只 stage 本次任务相关文件。
