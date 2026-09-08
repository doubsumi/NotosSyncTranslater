# 架构设计:双语段表 + 句子级 CRUD

## 1. 问题本质

早期实现把两个输入框当作两份“自由文本”,编辑任一侧后对另一侧做**整篇重组**:
翻译结果与原文句子之间没有持久、可寻址的对应关系,于是“改一句”也会触发整篇重排;
译文侧新增句子时,原文侧因整体重建而出现“整段刷新、在新增句处截断”。

## 2. 核心抽象:双语段表(Segment Table)

文档不再是两份自由文本,而是一张**有序 token 表**:

```
tokens = [ TEXT(seg#1), SEP(" "), TEXT(seg#2), SEP("\n"), TEXT(seg#3), ... ]
```

- `TEXT(seg#i)` 指向一个**句子段(segment)**,段内同时保存两种语言文本:
  `seg = { id, L, R }`(`L`=左语言句子,`R`=右语言句子)。
- `SEP` 是句间共享的布局分隔符(空格 / 换行 / 空行),**两侧共用**,因此双栏天然 1:1。
- 两个面板只是同一张表的两个视图:

```
left  = join( seg.L + SEP )
right = join( seg.R + SEP )
```

**id 是全局稳定的句子标识**。前端按 id 提交翻译、按 id 更新显示;后端两侧方向
(`left→right` 与 `right→left`)共用同一 `sid` 作为寻址键。

## 3. 句子级 CRUD 算法

### 3.1 分词(tokenize)

编辑侧文本先按“块(换行)→ 有界句单元(≤200 字符,优先句号/弱分隔符)”切分为
`TEXT / SEP` token 序列,满足 `join(token.text) === 原文`(布局零损失)。

### 3.2 Token 对齐(把编辑映射成 CRUD)

设旧表 token 为 `old`,编辑侧新文本 token 为 `next`:

1. **前缀/后缀裁剪**:两端 `type+text` 完全相同的 token 直接匹配(句与分隔符都
   不变 → id 不变、翻译不变)。
2. **中段处理**:
   - `oldMid.length === nextMid.length`:逐位“替换”。TEXT 位若文本不同 →
     **保留 id,更新该侧文本**,标记需重译;SEP 位 → 更新共享分隔符。
   - `oldMid.length !== nextMid.length`:对中段 token 做 **LCS(DP)**:
     - 匹配到的 TEXT → 保留 id;
     - 旧有而新无的 TEXT → **删段**(两视图同步移除该句);
     - 新有而旧无的 TEXT → **插段**(分配新 id,两视图同一位置插入该句)。
3. 结构变更直接作用在共享段表上,因此**另一侧自动完成同样的增删**。

### 3.3 翻译与渲染(按 id 实时更新)

- 仅对“变更/新增”的 id:清空其另一侧文本,并以 `sid=id` 单句提交后端队列
  (`POST /docs/{doc}/segments/sync`,方向由编辑侧语言对决定)。
- 每句结果返回后写回 `seg.R/L`,重渲染受影响句子;CodeMirror 以**最小差异事务**
  只替换该句区间 —— 不整篇重绘、不整篇请求、不截断。

## 4. 关键性质

- **幂等/去重**:同一句子文本后端按 `(from,to,text)` 翻译记忆命中,撤销/粘贴旧文
  零上游请求。
- **增删改查双向一致**:删句→两侧同删;插句→两侧同插(新句翻译后填入);改句→
  仅该句两侧变化。
- **单语言面板**:待翻译句子的对侧为空白,绝不把源语言写进目标面板。
- **对齐**:`alignFor` 直接从段表逐句计算 `L/R` 字符区间,选区/光标句高亮、滚动
  联动都以句子 id 对齐。

## 5. 分层

```
frontend/src/lib/
  blocks.ts    句子切分 / 有界单元(纯函数)
  tokens.ts    文本→token、token 级 LCS 对齐(纯函数)
  controller.ts SyncController v6:段表、CRUD、按 id 流式翻译、对齐
  cm.ts        CodeMirror 装饰与最小差异回写
  api.ts       /docs/{doc}/segments/sync 协议
backend/app/core/
  segdoc.py    docId→sid 句级队列(LRU+TTL)、按 sid 增量处理、alive 剪枝
  cache.py     翻译记忆(sha1(from·to·text))
  engine.py    多引擎池 / 故障转移 / 熔断 / 乱码防护
```
