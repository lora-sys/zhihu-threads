# Zhihu Threads — 项目上下文

## 产品本体

Zhihu Threads（前称 Living Answer）是一个知乎学习线生成器。用户在唯一主入口输入
模糊问题 → 系统澄清学习意图 → 搜索知乎回答和专栏文章 → AI 解释候选、用户选取
摘录 → AI 合成记忆廊桥 → 持久化到 SQLite → 在 `/thread/$threadId` 阅读学习桥、
Study Badge、追问和收藏导出。

核心价值：同一知识点在知乎上有不同年份、不同视角的真实内容。Zhihu Threads
把它们整理成可追溯的学习线程，让用户理解定义、因果、演变和分歧，而不是只看到
一个孤立答案。

## 当前功能

- [x] 模糊问题澄清
- [x] 知乎搜索（回答 + 专栏文章，标注来源类型）
- [x] AI Candidate Map 解释候选作用，用户仍手动选择
- [x] 手动选取摘录
- [x] AI 合成记忆廊桥和学习节点（关系/因果/演变/共识/分歧/前提变化/待确认）
- [x] 持久化的学习线程与学习指南
- [x] 线程阅读器（学习桥 + 学习节点 + 来源模态框）
- [x] Thread Study Agent（有依据 / 证据不足，提供下一步动作）
- [x] 首页展示精选真实学习线程
- [x] 本地收藏与 Markdown / JSON 导出
- [x] Study Badge 压缩学习成果
- [x] Agent 支持补充来源建议，用户确认后回到搜索
- [x] 264 条冻结黄金集 + 真实工作流 eval harness + /evals 看板

## 环境变量

以下变量必须设置在 `.env` 中：

| 变量                       | 用途                                            |
| -------------------------- | ----------------------------------------------- |
| `ZHIHU_ACCESS_SECRET`      | Zhihu API 访问密钥                              |
| `OPENAI_BASE_URL`          | 兼容 OpenAI 的模型服务地址                      |
| `OPENAI_API_KEY`           | 模型服务密钥                                    |
| `OPENAI_MODEL`             | 兼容 OpenAI 的模型名称                          |
| `ZHIHU_OAUTH_APP_ID`       | 黑客松 OAuth App ID（登录）                     |
| `ZHIHU_OAUTH_APP_KEY`      | 黑客松 OAuth App Key（仅服务端）                |
| `ZHIHU_OAUTH_REDIRECT_URI` | 与赛事页面登记值完全一致的回调地址              |
| `SESSION_SECRET`           | 至少 32 字符，用于加密登录会话 Cookie           |
| `TURSO_DATABASE_URL`       | 可选；设置后使用托管 SQLite，未设置回退本地文件 |
| `TURSO_AUTH_TOKEN`         | Turso 访问 token                                |

完整部署步骤见 [docs/deploy-koyeb-turso.md](docs/deploy-koyeb-turso.md)。

## 数据流

```
用户输入 → clarifyQuestion → refinedQuery + learningIntent
       ↓
searchAnswerCandidates → AnswerCandidate[]（含 sourceContentType: Answer|Article）
       ↓
rankAnswerCandidates → CandidateRankingAnalysis（解释候选，不代选）
       ↓
用户选择 → generateThreadArtifact → LearningNode[] + TimelineStage[]
       ↓
SQLite → 持久化 → threadId
       ↓
/thread/$threadId → askThreadAgent / thread-collection
```

## 依赖关系

- `better-sqlite3` 通过动态 `require` 导入（SSR 兼容）
- Zhihu 搜索通过官方 `zhihu_search` 接口获取摘要级 `Data.Items`
- 来源可以是知乎回答或专栏文章（`sourceContentType: "Answer" | "Article"`），
  文章不挂 question，URL 形状为 `zhuanlan.zhihu.com/p/<id>`
- 模型调用通过兼容 OpenAI 的 `/chat/completions` 适配器
- Effect TS 用于组合服务端效果，所有结果序列化为 JSON 安全类型
- Vite+ 测试框架，351 tests

## 链接

- [Issues](https://github.com/lora-sys/zhihu-threads/issues)
