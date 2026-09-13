# 免费部署：Koyeb + Turso

目标：给评委一个公网 HTTPS Demo，容器本身不挂持久盘，数据写入托管 SQLite。

## 为什么是这两个服务

- **Koyeb 免费实例**：512MB 内存 / 0.1 vCPU / 2GB SSD，1 小时没有流量后缩到零，
  官方文档明确免费实例**不能挂 Volume**。
- **Turso 免费档**：5GB 存储、5 亿行读、1000 万行写、100 个数据库，不需要信用卡。
- 两者相加：**无状态容器 + 托管 SQLite**，重启和重新部署都不会丢线程、摘录和学习空间。

本地开发不需要任何托管服务：不设置 `TURSO_DATABASE_URL` 时，程序回退到
`.local/*.db` 的本地 SQLite 文件。

## 0. 前置

- GitHub 仓库（`lora-sys/zhihu-threads`）
- Koyeb 账号
- Turso 账号
- 赛事页面创建项目后分配的 OAuth App ID / App Key

## 1. 建 Turso 数据库

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create zhihu-threads
turso db show zhihu-threads --url     # libsql://... 即 TURSO_DATABASE_URL
turso db tokens create zhihu-threads  # 即 TURSO_AUTH_TOKEN
```

也可以直接在 Turso 控制台建库，复制 Database URL 并生成 token。

表结构不需要手动创建：首次请求时三个 store 会各自执行 `CREATE TABLE IF NOT EXISTS`。

## 2. 部署到 Koyeb

1. Create Service → GitHub → 选择仓库和 `main` 分支。
2. Builder 选 **Dockerfile**（仓库已包含），端口填 `3000`。
   - 容器启动命令是 `srvx serve --port ${PORT:-3000}`，监听所有网卡。
   - Koyeb 若注入 `PORT`，容器会跟随该端口；端口号以 Koyeb 服务配置为准。
3. Health check 路径填 `/api/health`（返回 `{"status":"ok"}`，不访问数据库或外部服务）。
4. 配置环境变量（全部作为 Secret，不要写进仓库）：

| 变量                                                  | 说明                                          |
| ----------------------------------------------------- | --------------------------------------------- |
| `TURSO_DATABASE_URL`                                  | Turso 的 `libsql://...` 地址                  |
| `TURSO_AUTH_TOKEN`                                    | Turso token                                   |
| `ZHIHU_ACCESS_SECRET`                                 | 知乎开放平台 Access Secret，搜索用            |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | 兼容 OpenAI 的模型服务                        |
| `SESSION_SECRET`                                      | 至少 32 字符的随机串，用于加密登录会话 Cookie |

首次部署先不要填 OAuth 三项：回调地址要等公网域名确定后才能在赛事页面登记。

5. 部署完成后记下公网地址，例如 `https://zhihu-threads-xxx.koyeb.app`。

## 3. 登记回调并开启登录

1. 在赛事页面创建项目，回调地址填：
   `https://<你的域名>/api/auth/zhihu/callback`
   （协议、域名、路径必须与登记值完全一致，不能多也不能少尾部斜杠）
2. 拿到 App ID / App Key 后，在 Koyeb 增加：

| 变量                       | 值                           |
| -------------------------- | ---------------------------- |
| `ZHIHU_OAUTH_APP_ID`       | 赛事页面分配的 App ID        |
| `ZHIHU_OAUTH_APP_KEY`      | 赛事页面分配的 App Key       |
| `ZHIHU_OAUTH_REDIRECT_URI` | 与登记值逐字符一致的回调地址 |

3. 重新部署（或重启服务）。未配置 OAuth 时导航栏不会显示登录按钮，因此不会出现死按钮。

## 4. 提交前验收

1. `GET /api/health` 返回 200。
2. 首页三张精选学习线都能打开（产物随包发布，不依赖数据库是否有种子数据）。
3. 完整走一遍：搜索 → 选择摘录 → 生成线程 → 阅读 → 追问。
4. 登录 → 顶部显示昵称头像 → 收藏一条 → 「我的学习空间」出现该条 → 退出登录后空间回到本机内容。
5. **跨设备验证**：登录状态下用另一台设备或浏览器隐身窗口登录同一账号，学习空间里能看到同一条。
6. 浏览器 DevTools 的 Network 面板里看不到 `ZHIHU_ACCESS_SECRET`、App Key、OAuth token。
7. 断网或额度耗尽时，页面给出诚实的失败提示，而不是空列表或假成功。

## 5. 已知边界

- Koyeb 免费实例在 1 小时无流量后缩零，下一次请求需要冷启动（数秒）。
- 中国大陆网络可达性需要实测：建议用手机流量和家用宽带各打开一次，若不稳定可以先换成国内试用型主机，
  代码不需要改动（Docker 镜像 + 环境变量即可迁移）。
- 知乎开放平台默认每个能力组每天 100 次、未实名 10 次；演示前先确认额度，避免评委体验时耗尽。
- Turso 与 Koyeb 都按免费额度运行，属于演示级环境，不承诺可用性 SLA。

## 6. 部署前的质量记录

当前分支的状态（提交对应 `feat/oauth-workspace-turso`）：

- 门禁：`vp check` 无错误、`pnpm test` 517 项通过、`vpr build` 成功。
- 镜像：`docker build` 成功，容器启动后 `/api/health` 返回 200，空数据库下首页与精选线程页均可正常渲染。
- 评测：`pnpm eval:offline` 80/80 契约与 10/10 合成场景通过；真实语义评测跑过 3 题 CI 同形配置
  （`EVAL_LIMIT=3`、单并发、最多 40 次调用），报告在 `.local/evals/v3/<run>/report.md`。

已知限制，提交材料里不要写成「评测通过」：

1. 冻结题集的第三个概念要求**字面命中**（例如「序列化边界」「组合使用」）。检索到的知乎摘录里没有这些词时，
   规则会报 `retrieval_missing`；产品的合成提示词又明确禁止用同义词改写技术术语，所以该门槛当前无法稳定通过。
2. 完整七步工作流（澄清→搜索→候选解释→选材→生成→读取→追问）在 `step-3.7-flash` 下单次执行约需 2–3 分钟，
   CI 的 180 秒执行预算会偶发 `DEADLINE_EXCEEDED`；评委交互式使用不受该预算限制，但生成阶段确实需要等待。
3. 评测器的 `guidance` 单元不参与不受支持率统计（候选解释属于流程说明，不是知识论断），该口径见 `docs/eval-v3.md`。
