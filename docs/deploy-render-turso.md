# 免费部署：Render + Turso

目标：给评委一个公网 HTTPS Demo。应用本身无状态（数据都在 Turso），所以不需要持久磁盘。

## 为什么是这两个服务

- **Render 免费实例**：免费 web service + Docker 构建 + 自定义域名 + 托管 TLS；每月 750 实例小时，
  15 分钟无流量后休眠，下一次请求约 1 分钟冷启动。官方 FAQ 说明免费实例不强制绑定支付方式。
- **Turso 免费档**：5GB 存储、5 亿行读、1000 万行写、100 个数据库，不需要信用卡。
- 组合后的效果：容器可以随部署重建，线程、摘录和学习空间仍然在托管数据库里。

本地开发不需要任何托管服务：不设置 `TURSO_DATABASE_URL` 时程序回退到 `.local/*.db`。

### 已排除的备选

| 平台                | 为什么排除                                                          |
| ------------------- | ------------------------------------------------------------------- |
| Koyeb               | 2026-02 并入 Mistral 后，官方 FAQ 写明新用户只能注册 Pro 及以上计划 |
| Zeabur 免费档       | 免费档只允许管理「你自己的服务器」，不含 Zeabur 托管的运行环境      |
| Hugging Face Spaces | Docker Space 现在需要 PRO 付费计划                                  |
| Northflank Sandbox  | 免费但要求绑定支付方式                                              |

## 0. 前置

- GitHub 仓库（`lora-sys/zhihu-threads`）与要部署的分支
- Render 账号
- Turso 账号与数据库（见下）
- 赛事页面创建项目后分配的 OAuth App ID / App Key

## 1. 建 Turso 数据库

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create zhihu-threads
turso db show zhihu-threads --url     # libsql://... 即 TURSO_DATABASE_URL
turso db tokens create zhihu-threads  # 即 TURSO_AUTH_TOKEN
```

表结构不用手工建：首次请求时各 store 会执行 `CREATE TABLE IF NOT EXISTS`。

## 2. 部署到 Render

仓库根目录的 `render.yaml` 是蓝图：Docker 运行时、免费计划、健康检查 `/api/health`，
所有密钥都用 `sync: false`，由创建时在面板里填写。

1. Render 控制台 → **New** → **Blueprint** → 连接本仓库并选择要部署的分支。
2. Render 读取 `render.yaml` 后要求填写以下值：

| 变量                                                                      | 值                                   |
| ------------------------------------------------------------------------- | ------------------------------------ |
| `TURSO_DATABASE_URL`                                                      | Turso 的 `libsql://...` 地址         |
| `TURSO_AUTH_TOKEN`                                                        | Turso token                          |
| `ZHIHU_ACCESS_SECRET`                                                     | 知乎开放平台 Access Secret（搜索用） |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`                     | 兼容 OpenAI 的模型服务               |
| `ZHIHU_OAUTH_APP_ID` / `ZHIHU_OAUTH_APP_KEY` / `ZHIHU_OAUTH_REDIRECT_URI` | 见下一步，可先留空                   |

`SESSION_SECRET` 由蓝图自动生成。

3. 部署完成后记下公网地址，例如 `https://zhihu-threads-xxxx.onrender.com`。

## 3. 登记回调并开启登录

1. 赛事页面创建项目，回调地址填 `https://<你的域名>/api/auth/zhihu/callback`
   （协议、域名、路径必须与登记值逐字符一致）。
2. 拿到 App ID / App Key 后填进 Render 的 `ZHIHU_OAUTH_APP_ID` / `ZHIHU_OAUTH_APP_KEY`，
   `ZHIHU_OAUTH_REDIRECT_URI` 填与登记值完全一致的地址。
3. 重新部署。未配置 OAuth 时导航栏不显示登录按钮，因此不会出现死按钮。

## 4. 提交前验收

1. `GET /api/health` 返回 200。
2. 首页三张精选学习线都能打开（产物随包发布，不依赖数据库种子）。
3. 完整走一遍：搜索 → 选择摘录 → 生成线程 → 阅读 → 追问。
4. 登录 → 顶部显示昵称头像 → 收藏一条 → 「我的学习空间」出现该条 → 退出后空间回到本机内容。
5. 跨设备：登录状态下用另一台设备或隐身窗口登录同一账号，学习空间里能看到同一条。
6. 浏览器 DevTools 的 Network 面板里看不到 `ZHIHU_ACCESS_SECRET`、App Key、OAuth token。
7. 断网或额度耗尽时给出诚实的失败提示，而不是空列表或假成功。

## 5. 已知边界

- Render 免费实例 15 分钟无流量休眠，下一次请求约 1 分钟冷启动（Render 会显示加载页）。
- 中国大陆可达性需要实测：建议手机流量与家用宽带各打开一次。
- 知乎开放平台默认每个能力组每天 100 次、未实名 10 次；演示前先确认额度。
- Render 与 Turso 都按免费额度运行，属于演示级环境，不承诺可用性 SLA。

## 6. 部署前的质量记录

- 门禁：`vp check` 无错误、`pnpm test` 517 项通过、`vpr build` 成功。
- 镜像：`docker build` 成功，容器启动后 `/api/health` 200，空数据库下首页与精选线程页正常渲染。
- 存储：托管库集成测试通过（DDL、upsert、摘录读写、学习空间增删）。
- 评测：`pnpm eval:offline` 80/80 契约与 10/10 合成场景通过；真实语义评测跑过 3 题 CI 同形配置，
  报告在 `.local/evals/v3/<run>/report.md`。

### 线上验收（2026-09-14）

- 服务：`https://zhihu-threads.onrender.com`，`/api/health` 200，首页与精选线程页正常。
- 真实 OAuth：`app_id=574`，授权跳转、回调 state 校验、`/user` 读取、密封会话 Cookie 全部跑通；
  授权用户的知乎昵称与头像在站点显示，账号学习空间按 uid 落库。
- 线上搜索：返回真实知乎候选，说明生产环境仍走 Turso 写入。
- 敏感扫描：公网响应与客户端产物中均未出现 App Key 与开放平台 Access Secret。

已知限制，提交材料里不要写成「评测通过」：

1. 冻结题集的第三个概念要求**字面命中**（例如「序列化边界」「组合使用」）。检索摘录里没有这些词时规则会报
   `retrieval_missing`；产品提示词又明确禁止用同义词改写技术术语，因此该门槛当前无法稳定通过。
2. 完整七步工作流在 `step-3.7-flash` 下约需 2–3 分钟，CI 的 180 秒执行预算会偶发 `DEADLINE_EXCEEDED`。
3. 评测器的 `guidance` 单元不参与不受支持率统计（候选解释属于流程说明，不是知识论断），口径见 `docs/eval-v3.md`。
