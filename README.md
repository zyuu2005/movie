# 电影夜 · 雨和奇的双人电影抽签

固定给“雨”和“奇”使用的双人共享片单。没有账号、登录和房间码，所有设备访问同一个 Node 服务即可共享同一份 SQLite 数据，并通过 2.5 秒轮询自动同步。

> **仅限私人非商用使用。** 服务没有访问权限控制，请勿暴露到不受信任的公开网络。

## 1. 技术栈与目录

- 前端：原生 HTML + CSS + JavaScript，无构建步骤
- 后端：Node.js + Express
- 数据库：SQLite，使用 Node.js 内置 `node:sqlite`
- 电影搜索：前端 → 本项目 Express 后端 → TMDB v3 Search Movie API
- 数据库内部用 A/B 表示雨/奇，以便严格区分各自影片的修改权限

```text
电影之夜/
├── server.js             # 后端：固定片单接口、抽签逻辑、TMDB 代理
├── db.js                 # 后端：SQLite 自动建表、共同片单比对
├── package.json          # 依赖与启动命令
├── public/
│   ├── index.html        # 前端：页面结构
│   ├── styles.css        # 前端：柔和视觉与移动端适配
│   └── app.js            # 前端：身份、搜索、片单、抽签与轮询
├── tests/api.test.js     # 核心接口及 TMDB 代理测试
└── data/movie-night.db   # 首次启动自动创建
```

## 2. 安装与启动

### 环境要求

- Node.js **22.5.0 或更高版本**，推荐 LTS 版本
- npm，通常随 Node.js 一起安装

```bash
node --version
npm --version
```

### 启动项目

在项目根目录执行：

```bash
npm install
npm start
```

看到以下提示即可：

```text
🎬 电影夜已启动：http://localhost:3000
📁 SQLite 数据库：.../data/movie-night.db
```

当前电脑打开 `http://localhost:3000`。首次访问选择“雨”或“奇”，身份只保存在当前浏览器。停止服务按 `Ctrl + C`。

开发预览命令：

```bash
npm run dev
# 或指定端口
npm run dev -- --port 7100
```

SQLite 会在首次启动时自动创建目录、文件和数据表，无需执行 SQL。数据文件默认为 `data/movie-night.db`，重启不会清空，备份该文件即可备份片单。

## 3. 本地局域网访问

让两台手机连接与电脑相同的 Wi-Fi：

1. 电脑上执行 `npm start`，保持终端运行。
2. 查询电脑局域网 IPv4 地址：
   - Windows：运行 `ipconfig`，查看无线网卡的 `IPv4 地址`。
   - macOS/Linux：运行 `ifconfig` 或 `ip addr`。
3. 假设地址是 `192.168.1.8`，两台手机都打开：
   `http://192.168.1.8:3000`
4. 两台设备分别选择“雨”和“奇”即可，不需要输入任何房间号。
5. 如果无法访问，检查电脑防火墙是否允许 Node.js 或 TCP 3000 端口在专用网络通信，以及路由器是否开启了设备隔离。

注意：电脑关机、终端停止或切换网络后，手机可能无法访问。所有设备必须访问同一个服务地址，不能各自启动独立服务。

## 4. TMDB Key 与后端代理

1. 在 [TMDB](https://www.themoviedb.org/) 注册并登录。
2. 打开 [API 设置](https://www.themoviedb.org/settings/api)，按非商业用途申请 API。
3. 复制 **API Key（v3 auth）**，不要误用 v4 Read Access Token。
4. 在页面展开“TMDB API 设置”，粘贴并保存。

搜索流程为：

```text
浏览器提交 apiKey + 关键词
        ↓
POST /api/tmdb/search（本项目后端）
        ↓
Node.js 请求 api.themoviedb.org/3/search/movie
        ↓
后端整理 tmdbId、海报、片名、年份、简介后返回浏览器
```

浏览器不直接请求 TMDB 搜索接口，因此不会遇到该接口的浏览器 CORS 跨域问题。Key 保存在各自浏览器 `localStorage`，搜索时发送到本项目后端用于一次转发，不写入 SQLite。部署到不受信任的网络时应启用 HTTPS，避免 HTTP 明文传输 Key。

运行服务的环境需要能够访问 `api.themoviedb.org`；展示海报的设备需要能够访问 `image.tmdb.org`。

## 5. 个人资料、片单、评分与评论

- 雨和奇分别添加、删除、修改自己的影片，对方片单只读，但双方都可以评分和评论。
- 点击右上角名字可设置头像和显示名字。默认名字为雨/奇，名字最长 12 个字符。
- 头像支持 JPG、PNG、WebP，原图最大 5 MB；浏览器自动居中裁剪并压缩为 256×256 JPEG，再存入 SQLite。
- 点击影片的“评分与评论”，可独立打 1–5 星，重复评分会覆盖自己的旧评分，并显示双方评分和平均分。
- 每条评论最长 500 字，只能删除自己的评论。双方片单都移除某部电影时，其评分和评论一并清理。
- 头像、名字、评分、评论均存入服务端 SQLite，并随片单一起同步，换设备不会丢失。
- 后端按 `tmdb_id` 自动比对，双方都有同一影片时生成“共同想看”。
- 已看完的影片不参与抽签，也可以取消已看标记。
- 任意一人都能抽签：优先从双方均未看完的共同影片中随机抽取；没有时，再从双方所有未看完影片中抽取。
- 抽签按 `tmdb_id` 去重，同一影片不会因两人都添加而增加权重。
- 抽签结果写入 SQLite，不会自动标记已看；所有打开页面会在下一轮轮询时更新。
- 页面每 2.5 秒轮询一次，切回页面和网络恢复时也会立即同步。
- 重置全部已看标记需要二次弹窗确认。
- 清空全部片单需要输入“清空全部片单”二次确认，同时删除评分、评论和抽签结果，但保留双方头像和名字。
- 每部电影可设置一个分组（30 字以内，如“周末看”“悬疑”），影片卡片上可修改或移出分组；抽签区可选“抽签范围”只在某个分组里抽，优先级规则不变：共同未看优先，其次该分组内所有未看。
- 页面底部“片单管理与备份”里可导出 JSON 备份（含片单、分组、头像、评分、评论和抽签结果，不含 TMDB Key）；导入备份需输入“恢复备份”二次确认，服务端在事务中整库替换，格式不对会拒绝且不影响现有数据。SnapDeploy 等容器重新部署可能重置数据，正式片单添加后建议先导出一份 JSON 备份。

页面底部固定标注：

```text
This product uses the TMDB API but is not endorsed or certified by TMDB.
```

## 6. 云端部署：Render + 持久 SQLite

项目已包含 `render.yaml` 和 `.node-version`，部署后会运行一个 Node 实例，并把唯一数据库保存到 Render 的 1 GB 持久磁盘。任何设备访问同一个云端 HTTPS 地址，看到的都是同一份完整片单。

### 上线步骤

1. 创建一个 **GitHub 私有仓库**，把本项目推送到仓库。`.gitignore` 已排除 `data/`、所有 SQLite 文件和 `node_modules/`，数据库与 TMDB Key 不会进入仓库。
2. 登录 Render，选择 **New → Blueprint**，连接上述仓库并读取根目录的 `render.yaml`。
3. 核对配置：`starter` 实例、新加坡区域、`movie-night-data` 持久磁盘、挂载路径 `/var/lib/movie-night`。
4. 确认付费资源后点击 **Apply**。Render 会安装依赖、启动服务并提供 HTTPS 地址。
5. 部署完成后访问 `https://你的服务地址/api/health`，返回 `{ "ok": true }` 即后端正常。
6. 在任何手机或电脑打开同一个 HTTPS 地址，分别选择雨/奇即可。无需再在设备间导入或复制数据。

Render 配置中的 `DB_PATH=/var/lib/movie-night/movie-night.db` 指向持久磁盘，不能在控制台删除这项配置，也不要把服务扩展成多个实例。持久磁盘与运行实例会产生费用，以 Render 账户显示为准；磁盘可以扩容但不能缩小。

### 已有本地片单

云端首次启动会创建一份新的空数据库。若以后已有需要保留的本地片单，先备份 `data/movie-night.db`；不要把它提交到 GitHub，应在部署前单独完成数据库迁移。

### 通用 VPS 部署

也可以不使用 GitHub，直接把项目上传到 VPS，执行 `npm ci --omit=dev && npm start`，并用 pm2/systemd 保持单进程运行。必须保证 `DB_PATH` 指向持久磁盘，并自行配置 HTTPS。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口，Render 会自动提供 |
| `DB_PATH` | `./data/movie-night.db` | SQLite 文件位置，云端必须指向持久磁盘 |

## 7. 自动化测试

```bash
npm test
```

测试使用独立临时数据库和本地 TMDB 模拟服务，不修改正式片单，也不消耗真实 TMDB 请求。覆盖代理字段映射、固定双人片单、共同片单比对、优先抽签、头像读取、自定义名字、双人评分、评论权限、已看状态、二次确认清空，以及使用相同 `DB_PATH` 重启后的数据持久化。
