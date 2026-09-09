# Eval v3 使用与设计

## 验证范围

本实现位于 `feat/eval-v3-offline-agent-harness` 分支，基于 `6c34a81`。离线契约已经验证，完整仓库的类型、格式、构建和真实处理函数集成结果以 PR 检查为准。没有运行真实模型或知乎业务评测。发布与合并前需要单独确认这些项目。

离线复验范围见 `docs/eval-v3-verification.md`。不能把合成场景通过解释成真实模型准确率，也不能把语法转译检查解释成全仓构建通过。

## 文件职责

| 文件                                    | 职责                                             |
| --------------------------------------- | ------------------------------------------------ |
| `types.ts`                              | 任务、执行输入、预期、观察、尝试与报告契约       |
| `execution.ts`                          | 单步、固定流程、多轮和有限自主执行               |
| `grading.ts`                            | 独立规则检查、逐轮语义检查与任务完成判断         |
| `runtime.ts`                            | 超时、取消、调用预算、用量记录                   |
| `runner.ts`                             | 全部尝试、首次与重试、回归比较、选题、报告、脱敏 |
| `network.ts`                            | 评测进程内的请求记录、离线阻断与域名限制         |
| `policy.ts`                             | 模型自主决策及语义裁判协议                       |
| `bridge.ts`                             | 当前业务处理函数的响应归一化                     |
| `product-runtime.ts`                    | 接入真实业务处理函数、模型适配器与独立 SQLite    |
| `legacy.ts`                             | 读取旧黄金集，不将普通问题伪装成真实缺陷回归     |
| `live.ts` 和 `live.test.ts`             | 必须明确开启的真实评测入口                       |
| `contracts.ts` 和 `bridge-contracts.ts` | 确定性故障、评分器、执行器和适配契约测试         |
| `product.integration.test.ts`           | 使用真实业务函数和 SQLite 的离线集成测试         |
| `offline.ts`                            | 无需项目依赖的离线驱动，失败退出非零             |

## 离线运行

在项目根目录执行下面的命令，不需要模型密钥。

```bash
node --unhandled-rejections=strict --experimental-strip-types src/evals/v3/offline.ts
```

已安装项目工具时也可以运行 `pnpm eval:offline`。要求 Node 22.16 或更高版本。驱动阻断真实 fetch。来源明确标为合成内容，模型返回也是模拟值。合成 token 数用于验证统计代码，不是实际账单。

输出在 `.local/evals/v3/offline`。`contracts.json` 保存每项契约的名称、变更路径、结果和耗时。`report.json` 与 `report.md` 保存场景、全部尝试、规则结果、语义状态和用量。

完整项目还需要执行下面的验收命令。

```bash
pnpm exec vp test src/evals/v3
pnpm exec vp check
pnpm exec vp build
```

`product.integration.test.ts` 通过注入 HTTP 响应运行真实处理函数和 SQLite，不是在线模型评测，不读取生产数据库。它覆盖正常存储流程、拒绝危险输入、超长输入和错误搜索响应。

## 结果怎样读

`firstAttemptSuccess` 表示第一次规则与语义均通过。`retrySuccess` 表示第一次未达到该标准，但后续重试达到。`firstAttemptRulesPass` 和 `retryRulesPass` 只表示规则检查。

每次尝试独立保存 `execution`、`grade`、`calls`、`executionMs`、`gradingMs` 和 `wallMs`。不择优删除失败尝试。只有执行返回的临时错误触发整题重试，质量低分不触发反复抽取好答案。自主策略在同一尝试内恢复工具错误时，动作保存在 `steps` 中，与整题重试分开。

每次请求发出时建立调用记录。超时、取消和没有返回 usage 的请求不会消失。未知 token 与费用保留 `null`，同时报告已知小计和未知调用数。产品、自主策略与裁判分别有阶段字段。`providerDurationMs` 是请求耗时总和，不是用户等待时间。

规则为 `pass` 且没有裁判时，最终判定为 `unjudged`。裁判超时为 `unavailable`，格式或输出单元列表不完整为 `invalid`。这些状态不会自动成为语义成功。代码硬检查失败时，裁判不能将结果改成通过。

`unsupportedRate` 是已评判输出单元中不受支持的比例，不是逐条事实的总体幻觉率。`taskComplete` 单独保存。没有语义评判时，两者均为未知。实际学习收益仍需观察用户完成任务。

## 执行与评分隔离

执行器只接收 `Input`。预期结果、用例 ID 和回归标签不传给产品或自主策略。输入字段经过白名单复制。固定流程根据用户模拟选择或统一的前三条来源策略选材，不读取 `minSources`。

`expected` 仅用于评分。先让产品根据输入执行或拒绝，再检查结果。不会因为预期结果写着拒答，就由脚本停止生成。旧黄金集转换也遵守这一约束。

`single_step` 调用一个明确模块。`workflow` 执行澄清、搜索、候选解释、选择、生成、读取和追问。`multi_turn` 要求明确追问列表，并检查问题按顺序得到处理。`autonomous` 由模型根据实际观察选择下一步。

自主模式仅用于实验性评测，不改变公开产品的默认流程。工具白名单、来源选择验证、终止条件、步数、调用数及时间预算始终生效。离线脚本策略只验证协议与限制，没有证明真实模型的自主能力。

## 证据与多轮检查

引文存在表示文字出现在对应摘录中。来源绑定表示来源 ID、指纹、链接以及实际展示的作者属于同一来源。语义支持由裁判判断结论是否超出或歪曲材料。

一个节点可以引用多份材料，各条引用独立匹配指纹。主来源必须有效，并且属于该节点引用的来源之一。Agent 显式返回错误来源 ID 时，适配层保留错误供评分器发现，不偷偷修正。

生成产物的来源元数据必须匹配观察到的来源。读取检查产物内容，而非只检查 ID。由于产品生成接口只返回 ID，适配层先读取实际存储产物，再执行明确的 `read` 步骤。这检查实际存储与重复读取的一致性，不声称直接比较模型原始输出与入库前对象。

每轮回答保存当时可用的材料和线程已选来源。后来的检索结果不能替先前回答补证。裁判取得原始学习目标、全部输出单元、追问和各自证据。合理证据不足、过度拒答、不受支持的结论与整体任务完成分开统计。提出补充查询不等于补充查询已经解决问题。

## 能力与回归

能力用例检查系统能完成哪些任务。回归用例必须有具体契约、受影响路径和可复现输入或故障条件。旧黄金集中名称带 BUG 的普通问题导入后仍是能力探针，不自动成为真实回归。

合成单步端口不冒充真实业务模块测试。实际处理函数的回归另由 `product.integration.test.ts` 验收。

通过 `EVAL_CHANGED_FILES` 选择自定义回归任务，按完整路径或目录前缀匹配。基线比较要求任务及预期内容哈希、题集、评分器代码、策略、预算、裁判配置和证据输入一致。首次规则失败不能被重试恢复隐藏，未评判也不冒充已测得的语义退化。

固定证据的单步比较适合检查提示词或生成逻辑。真实检索会变化，配置相同也只提供观察结果，不能自动证明分数变化由代码造成。

## 用户后续运行真实评测

先完成离线集成验收，凭据仅从环境变量读取，不写入源码、报告或 Notion。

```bash
EVAL_LIVE=1 EVAL_LIMIT=1 EVAL_MAX_RUN_CALLS=20 pnpm eval
```

必须配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 和 `ZHIHU_ACCESS_SECRET`。关闭裁判不关闭产品自己的模型调用。

```bash
EVAL_LIVE=1 EVAL_JUDGE=false EVAL_LIMIT=1 pnpm eval
```

自主模式先限定一题。

```bash
EVAL_LIVE=1 EVAL_MODE=autonomous EVAL_LIMIT=1 \
  EVAL_MAX_STEPS=12 EVAL_MAX_RUN_CALLS=25 pnpm eval
```

默认并发 1，最多两次整题尝试，每次 16 步和 40 个请求，每个运行默认 100 个请求。执行截止为 180 秒，裁判截止为 30 秒。对应变量为 `EVAL_CONCURRENCY`、`EVAL_MAX_ATTEMPTS`、`EVAL_MAX_STEPS`、`EVAL_MAX_CALLS`、`EVAL_MAX_RUN_CALLS`、`EVAL_EXECUTION_TIMEOUT_MS` 和 `EVAL_JUDGE_TIMEOUT_MS`。

单次真实运行最多 50 个任务。现有存储接口没有公开 close 方法，后续应补显式释放或独立工作进程。每次尝试使用不同数据库目录，不复用生产状态。

`EVAL_DATASET` 支持原始 v1 和 v2 黄金集，检查对应 manifest 的哈希和条目数。`EVAL_CASE_IDS` 固定题目 ID，`EVAL_FILTER` 匹配 ID 或标题。`EVAL_OFFSET` 独立跳过条目。`EVAL_STRIDE` 只是索引取样，不宣称统计分层。设置 `EVAL_REQUIRE_SEMANTICS=1` 后，所有运行任务必须达到语义通过。

`EVAL_TASK_FILE` 可读取 `.local/evals/fixtures` 或 `src/evals/datasets` 下的 JSON 任务数组。单步任务需要 `input.step`，使用固定来源时还需完整元数据。`EVAL_PURPOSE` 可选 `capability` 或 `regression`。

运行后可导出固定证据，人工核对学习目标和预期后再作为后续测试输入。

```bash
node scripts/eval-extract-fixed.mjs \
  .local/evals/v3/RUN_ID/report.json CASE_ID \
  .local/evals/fixtures/fixed-generate.json
```

导出器不覆盖现有文件，不会自动把旧输出当标准答案。固定 artifact 初始化通过域工厂重建学习指南，是受控初始化而非原生数据库逐字镜像。

`EVAL_BASELINE` 可指向已完成的 v3 `report.json`。旧入口保留为 `pnpm eval:legacy`。旧 `/evals` 页面只展示旧格式，新报告使用 JSON 和 Markdown，不混用两种总分。

## 待验证与限制

提交前独立离线测试已通过，完整处理函数集成、全仓检查和构建需以 PR 检查结果为准。真实模型效果、裁判人工校准、浏览器验收和学习收益均未验证。未改造前端评测看板，也未声称修复产品域层全部引用问题。

## 设计来源

- [Anthropic agent eval 指南](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，任务、尝试、执行记录、评分器及能力与回归的区分。
- [LangChain 复杂 Agent 评测](https://docs.langchain.com/langsmith/evaluate-complex-agent)，单步、过程及结果评测。
- [Effect 运行与取消](https://effect.website/docs/v3/getting-started/running-effects)，执行与取消行为。
