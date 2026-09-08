# Notos 同步翻译器 · Notos Sync Translator

> 实时 **双向同步翻译** Web 应用：任意粘贴即译；修改任意一侧，另一侧即时同步。
> Backend: Python (Flask) · Frontend: React + TypeScript + Vite · 免费公共翻译引擎，无 API Key。

```
┌──────────────────────────┐   ⇄   ┌──────────────────────────┐
│  原文（自动检测：中文）     │       │  译文（自动选择：英语）     │
│  今天天气很好，我们一起去散步吧│  ⇄  │  The weather is very      │
│  修改这里 → 实时同步到右边    │       │  nice today, let's walk…  │
└──────────────────────────┘       └──────────────────────────┘
```

## 核心特性

| 需求 | 实现 |
| --- | --- |
| 双侧可编辑、双向同步 | 最近编辑的一侧为“源文档”，另一侧为其镜像；你编辑哪一侧，同步就朝哪个方向进行；支持交换（⇄） |
| 自动识别语言（默认） | 客户端即时脚本级检测 + 服务端 `auto` 复核；**中文→英文、英文→中文、其它语言→中文** 自动配对 |
| 商业级防抖 | 停键入 **800 ms** 后请求；连续输入 **max-wait 2.6 s** 兜底触发；过期请求通过 AbortController + 代际号（generation）作废，绝不覆盖新内容 |
| **句级队列协议（核心）** | 每侧 = 一个 `docId` 文档队列；句子为带稳定 `sid` 的缓存单元。**粘贴后目标区先逐字镜像原文，再按句排队、逐句提交、逐句翻成译文**；编辑只把**被改句子的 sid+新文本**上送后端队列，后端只处理并返回该 sid，前端只更新该 sid 的文本区域 |
| **sid 一致性** | 编辑/增删句子用“前后缀锚点”重排：未变句子 sid 不变（后端按 sid 复用队列/记忆）；插入的新句分配新 sid；被删句随 `alive` 列表在后端队列剪除 |
| 有界单元 | 长句/无标点稠密文本按 ≤400 字符确定性切为稳定单元，任何单句/单次请求都有界（无整段重译、无超时） |
| 双侧滚动联动 | 滚动一侧输入框，另一侧按比例同步滚动 |
| 选区/光标句子联动 | 选中某句，另一侧高亮对应译文/原文；**光标落在句内**时双侧框出该句（本侧短暂闪烁后还原光标）——基于逐句精确字符映射（漂移时回退段落比例映射） |
| 特殊字符不被转义 | 上游 Web 引擎会把 `<` 转成 `&lt;`：后端统一反转义 + 块内换行折叠，实体不会出现在译文 |
| 不设输入上限 | 任意长度文档按行/句/有界单元切分，并发受限的逐句请求 + 进度反馈，整体 O(n) |
| 报错/提醒用弹窗 | Toast 通知中心（右上角、aria-live），错误带“重试”，绝不把错误写进输入框 |
| 后端优雅健壮 | 句级队列(线程安全 LRU+TTL) + 翻译记忆双层缓存 + 多引擎池故障转移/熔断/EMA/pacing/乱码防护 + 全线程安全 |

## 技术栈与目录

```
.
├── backend/                 # Python 3.10+ · Flask
│   ├── app/
│   │   ├── core/
│   │   │   ├── detection.py      # 轻量语言检测（脚本比例 + 停用词打分，O(n)）
│   │   │   ├── segmentation.py   # 块级分割 / 超长句切块
│   │   │   ├── normalize.py      # 译文归一化：HTML 实体反转义、单行化、分块拼接
│   │   │   ├── segdoc.py         # 句级队列：docId→sid 缓存（线程安全 LRU+TTL）
│   │   │   ├── cache.py          # 翻译记忆：内存 LRU(TTL) + 可选 SQLite
│   │   │   ├── engine.py         # 多引擎池：故障转移、熔断、EMA、pacing、乱码防护
│   │   │   └── service.py        # 编排：auto 解析 → 切块 → 缓存 → 并发翻译/单句 ensure
│   │   ├── api/routes.py         # /api/health · detect · translate[/batch] · docs/{id}/segments/sync
│   │   └── config.py             # 全部可配（NST_* 环境变量）
│   ├── tests/                    # pytest（无网络单元测试 + 可选 live 冒烟）
│   └── run.py                    # 入口（优先 waitress）
├── frontend/                # React 18 + TypeScript + Vite · 编辑器内核 CodeMirror 6
│   └── src/
│       ├── lib/
│       │   ├── controller.ts     # SyncController v3：docId+稳定sid 句级队列、镜像优先、逐句流式（纯 TS 可测）
│       │   ├── debounce.ts       # 防抖(max-wait) / 速率门
│       │   ├── blocks.ts         # 块/句子/有界单元切分、镜像组合、选区映射
│       │   ├── tm.ts             # 会话级翻译记忆（LRU，备用）
│       │   ├── cm.ts             # CodeMirror 扩展：装饰高亮/最小差异回写/主题
│       │   ├── detection.ts      # 语言/自动配对规则（与服务端一致）
│       │   └── api.ts            # 类型化 API 客户端（队列协议、超时/取消）
│       ├── components/           # CodePaneInput(CM6)、面板、语言选择、Toast 等
│       └── hooks/useSyncTranslate.ts
├── Dockerfile / compose.yaml / .github/workflows/
└── .env.example
```

## 快速开始

### 本地运行

```bash
# 1. 后端
cd backend
python -m venv .venv && .venv\Scripts\activate        # Windows
pip install -r requirements-dev.txt
python run.py                                          # http://127.0.0.1:5000

# 2. 前端（另一个终端；开发模式走 Vite 代理 /api → Flask）
cd frontend
npm install
npm run dev                                            # http://127.0.0.1:5173

# 3. 生产形态：构建前端，由 Flask 同源托管
cd frontend && npm run build
cd ../backend && python run.py                          # 打开 http://127.0.0.1:5000
```

### Docker

```bash
docker compose up --build -d     # 多阶段构建：Node 出静态包 → Python 运行时
# 打开 http://localhost:5000
```

### 测试与质量门禁

```bash
cd backend && python -m pytest            # 后端单测（网络无关）
cd frontend && npm run check              # typecheck + vitest + 生产构建

# 真机冒烟（需要外网，访问上游引擎）
NST_LIVE_TESTS=1 python -m pytest -m "" tests/test_live.py   # 或 cd backend && set NST_LIVE_TESTS=1 && pytest tests/test_live.py
```

## 使用说明与体验细节

- **自动配对规则**（需求指定）：文本被识别为中文 → 目标自动为英文；英文 → 中文；其它语言（日/韩/法/德…）→ 中文。可在任一侧下拉框手动指定语言（含目标语言覆盖）。
- **双向编辑**：最近编辑的一侧成为“源”，另一侧为其镜像；支持“交换 ⇄”；“重译全文”以新文档重排全部句子；“清空”同步清空。
- **镜像优先 + 逐句流式**：粘贴/修改后，目标侧**立即先显示原文镜像**，随后每个句子按队列逐个提交、返回后原地翻成译文（CodeMirror 只对该句范围打补丁，不整文重绘）。
- **句级增量**：编辑只影响被改句子的 `sid`（前缀/后缀锚点保证其余 sid 不变）：只上送该 sid 与新文本，未改句零请求（撤销/粘贴旧文即时由队列/记忆返回）。
- **滚动联动与选区高亮**：任一侧滚动另一侧按比例跟随；选中/光标落在某句时，双侧以高亮框出对应原文/译文句子（CodeMirror decorations，漂移时回退段落比例映射）。
- **符号原样**：译文中的 `< > & "` 等特殊字符不会再出现 `&lt;`/`&gt;` 之类的转义形式。
- **实时反馈**：输入面板头部显示已检测语言与目标语言；长文翻译有句级进度与忙碌遮罩；右上角状态胶囊显示引擎与耗时。
- **会话记忆**：文本与语言选择自动持久化（localStorage，节流保存），刷新后恢复并提示。
- **错误即弹窗**：网络失败、引擎全部不可用等均以 Toast 呈现，可一键重试；绝不把错误文本写进输入框。
- **无障碍**：区域 role/aria-live、键盘可达、深浅色自动适配、焦点可见。
- **编辑器内核**：双栏基于 CodeMirror 6——句子高亮/光标句框选用原生 decorations；回写使用带标注的**最小差异补丁**（只替换被改句子的区间），绝不触发编辑回环。

## 后端算法设计（优雅性 / 开销 / 鲁棒性）

1. **句级队列（docId + sid）**
   每侧一个文档队列；文本 → 换行块（布局 1:1）→ **≤400 字符确定性单元**。编辑时用“前后缀锚点”重排 sid：未变句 sid 不变、插入句分配新 sid、被删句由 `alive` 剪除。**前端只上送被改句子的 sid+文本，后端句级队列只处理该 sid 并返回该 sid，前端只更新该 sid 区域**——任何一次请求都不会整段/超长（这是“修改哪里就请求哪里”的协议化实现）。
2. **双层缓存**：句级队列（线程安全 LRU+TTL，按 sid/语言对复用）在上，翻译记忆（内存 LRU + 可选 SQLite，`sha1(from·to·text)` O(1)）在下；重复/撤销/粘贴旧文零上游请求。
3. **镜像优先渲染**：目标区 = 源布局 + 每句“译文或原文占位”的逐句组合（未返回的句子保持原文），随逐句返回原位替换；CodeMirror 以最小差异事务只改该句区间。
4. **逐句精确对齐**：`alignFor` 输出每句在双栏中的字符区间，供选区/光标句子高亮；目标侧一旦偏离组合结果自动降级段落比例映射。
5. **译文归一化**（`normalize.py`）：HTML 实体反转义（`&amp;` 最后处理）、块内换行折叠与分块空白对齐，译文不含转义符、双栏布局永不因换行错位。
6. **多引擎池**（依赖 [`translators`](https://github.com/UlionTse/translators)，当前默认 `bing, alibaba, sogou`，可用环境变量替换）
   - 故障转移：按健康度 + 延迟 EMA 排序轮转；
   - 熔断：连续失败阈值后冷却跳过，避免坏上游拖垮整体；
   - pacing：同引擎两次调用间隔 ≥ 0.4 s，对免费端点友好；
   - 乱码防护：会话占位哈希判为失败并自动切换引擎；
   - 全局信号量控制真实并发。
7. **语言检测**：Unicode 脚本比例 + 拉丁停用词打分，低置信时交还 `auto`；单次线性扫描。
8. **健壮性**：逐句失败隔离、JSON 错误模型 `{error:{code,message}}`、每 IP token bucket 限流、gzip、request-id、访问日志。

> 说明：句子级增量把「请求量」压到最小；若个别句子脱离上下文翻译不佳（代词、衔接），可点击顶部「重译全文」以整段上下文强制刷新。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 存活、引擎健康度、缓存/句级队列统计、运行配置 |
| `POST` | `/api/detect` | `{text}` → `{lang, confidence, script}` |
| `POST` | `/api/docs/<doc>/segments/sync` | **句级队列（编辑器主协议）**：`{from,to,items:[{sid,text}],alive:[sids]}` → 只处理上送的句子，返回 `{sid, translated, cache, provider}`；`alive` 用于剪除被删句 |
| `POST` | `/api/translate[/batch]` | 通用翻译（兼容/单次调用，编辑器已改走队列协议） |

## 调研参考（为什么这样设计）

设计过程中参考了商业翻译产品的交互与工程实践：

- 实时增量翻译 / 流式翻译记忆架构：[Luminote ADR-002: Streaming Translation Architecture](https://github.com/grammy-jiang/Luminote/blob/master/docs/adr/002-streaming-translation-architecture.md)
- 高可用实时翻译系统的请求编排、防抖与状态管理要点：[构建高可用 JS 实时翻译系统的 6 个关键步骤](https://blog.csdn.net/QuickCode/article/details/153121414)
- DeepL / Google Translate 交互对照（自动检测、双语对照、目标语言可覆盖）：[Weglot: DeepL vs Google Translate](https://www.weglot.com/guides/deepl-vs-google-translate)
- 增量语音/语义单元流式处理中的“首批语义单元即返回”思路：[RK3566 在线翻译协同](https://blog.csdn.net/weixin_35757191/article/details/154400126)
- 免费无 Key 翻译引擎封装库：[translators](https://github.com/UlionTse/translators)

归纳出的商业化经验：**停顿型防抖 + max-wait 兜底**、**请求代际取消**、**分块 TM 增量请求**、**错误走通知而非内联**、**翻译进度可感知**、**会话可恢复**、**语言自动配对但允许显式覆盖** —— 均已在本项目中落地。

## 环境变量（节选，详见 `.env.example`）

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `NST_PROVIDERS` | `bing,alibaba,sogou` | 上游引擎池（按序尝试 + 熔断） |
| `NST_CACHE_TTL` / `NST_CACHE_MAX` | `86400` / `8192` | 翻译记忆有效期 / 容量 |
| `NST_CACHE_DB` | 空 | SQLite 持久缓存路径（可选） |
| `NST_CHUNK_MAX_CHARS` | `1600` | 单次上游请求的最大字符数 |
| `NST_PROVIDER_*` | — | 超时、pacing、并发、熔断参数 |
| `NST_RATE_LIMIT_*` | `240` / `30` | 每 IP 限流（token bucket） |

> 提示：免费上游引擎随地区/时段波动；本项目已做故障转移与冷却，若个别引擎在你的网络不可用会自动跳过。若在中国大陆部署，Google 等已在库中默认剔除（该库按区域探测离线即跳过）。

## Roadmap（可选方向）

- [ ] SSE/WebSocket 流式翻译（借鉴 ADR-002 的流式体验）
- [ ] 术语表 / 专业领域词典
- [ ] 中英混排保护、Markdown 格式保持
- [ ] 服务端持久 TM 的显式容量/统计管理界面

## License

[MIT](./LICENSE) © NotosSyncTranslater contributors
