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
| 双侧可编辑、双向同步 | 你在哪一侧输入，那一侧即“原文”，另一侧实时成为“译文”；支持交换（⇄） |
| 自动识别语言（默认） | 客户端即时脚本级检测 + 服务端 `auto` 复核；**中文→英文、英文→中文、其它语言→中文** 自动配对 |
| 商业级防抖 | 停键入 420 ms 后请求；连续输入时 **max-wait 1500 ms** 保证兜底触发；旧请求通过 AbortController + 代际号（generation）作废，绝不用过期结果覆盖新内容 |
| 节流 / 不重复请求 | 相同文本零请求：内容级 diff（前后缀窗口）+ 会话级翻译记忆（TM）命中即即时拼接；服务端另有内存 LRU（可选 SQLite 持久层）二次兜底 |
| **只请求修改部分** | 长文按换行分块、块级 diff；修改第 N 段只会上送第 N 段；TM 覆盖段落随改随走、撤销/粘贴旧文瞬时恢复 |
| 不设输入上限 | 超长段落按句号自动切块（≤1600 字符/块，可配置），任意长度文档 O(n) 分块并行翻译，逐波渐进填充 |
| 报错/提醒用弹窗 | Toast 通知中心（右上角、aria-live），错误带“重试”，绝不把错误写进输入框 |
| 后端优雅健壮 | 多引擎池 + 自动故障转移 + 熔断冷却 + 延迟 EMA + 每引擎节流 + 并发上限 + 请求去重 + 全线程安全 |

## 技术栈与目录

```
.
├── backend/                 # Python 3.10+ · Flask
│   ├── app/
│   │   ├── core/
│   │   │   ├── detection.py      # 轻量语言检测（脚本比例 + 停用词打分，O(n)）
│   │   │   ├── segmentation.py   # 块级分割 / diff 窗口 / 超长句切块
│   │   │   ├── cache.py          # 翻译记忆：内存 LRU(TTL) + 可选 SQLite
│   │   │   ├── engine.py         # 多引擎池：故障转移、熔断、EMA、pacing
│   │   │   └── service.py        # 编排：auto 解析 → 切块 → 缓存 → 并发翻译
│   │   ├── api/routes.py         # /api/health · /api/detect · /api/translate[/batch]
│   │   └── config.py             # 全部可配（NST_* 环境变量）
│   ├── tests/                    # pytest（无网络单元测试 + 可选 live 冒烟）
│   └── run.py                    # 入口（优先 waitress）
├── frontend/                # React 18 + TypeScript + Vite
│   └── src/
│       ├── lib/
│       │   ├── controller.ts     # SyncController：双向同步状态机（核心，纯 TS 可测）
│       │   ├── debounce.ts       # 防抖(max-wait) / 速率门
│       │   ├── blocks.ts         # 客户端块分割、diff、布局保持重建
│       │   ├── tm.ts             # 会话级翻译记忆（LRU）
│       │   ├── detection.ts      # 语言/自动配对规则（与服务端一致）
│       │   └── api.ts            # 类型化 API 客户端（超时/取消）
│       ├── components/           # 输入面板、语言选择、Toast 等
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
- **双向编辑**：在右侧输入/粘贴即把右侧当原文反向翻译；“交换 ⇄”一键对调两侧内容与语言；“重译全文”忽略缓存强制刷新；“清空”同步清空。
- **实时反馈**：输入面板头部显示已检测语言与目标语言；长文翻译有分段进度与忙碌遮罩；右上角状态胶囊显示引擎与耗时。
- **会话记忆**：文本与语言选择自动持久化（localStorage，节流保存），刷新后恢复并提示。
- **错误即弹窗**：网络失败、引擎全部不可用等均以 Toast 呈现，可一键重试；绝不把错误文本写进输入框。
- **无障碍**：区域 role/aria-live、键盘可达、深浅色自动适配、焦点可见。

## 后端算法设计（优雅性 / 开销 / 鲁棒性）

1. **分块与翻译记忆**
   文档 → 换行块 →（超长时按句号二次切块）。缓存键为 `sha1(from·to·text)`，**O(1) 命中**；未命中块由线程池（≤3 并发）并行请求，批内自动去重、请求间按键去重（in-flight 合并）。总体复杂度 O(n)、单次上游请求负载恒定，因此**没有输入长度上限**。
2. **多引擎池**（依赖 [`translators`](https://github.com/UlionTse/translators)，当前默认 `bing, alibaba, sogou`，可用环境变量替换）
   - 故障转移：按健康度 + 延迟 EMA 排序轮转；
   - 熔断：连续失败阈值后冷却跳过，避免坏上游拖垮整体；
   - pacing：同引擎两次调用间隔 ≥ 0.4 s，对免费端点友好；
   - 全局信号量控制真实并发，杜绝线程风暴。
3. **语言检测**：Unicode 脚本比例 + 拉丁停用词打分，只在高置信时给出代码，否则交还 `auto` 给引擎；单次线性扫描。
4. **健壮性**：批量请求**逐项失败隔离**；JSON 错误模型统一 `{error:{code,message}}`；每 IP token bucket 限流保护上游；gzip、request-id、访问日志齐备。
5. **可选持久缓存**：`NST_CACHE_DB` 指向 SQLite 时，跨进程/重启复用已译句子，进一步节省上游开销。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 存活、引擎健康度、缓存统计、运行配置 |
| `POST` | `/api/detect` | `{text}` → `{lang, confidence, script}` |
| `POST` | `/api/translate` | `{text, from?, to}` 单段翻译（`from` 可为 `auto`） |
| `POST` | `/api/translate/batch` | `{items:[{id,text,from,to,noCache?}]}` 批量、去重、并发、逐项失败隔离 |

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
