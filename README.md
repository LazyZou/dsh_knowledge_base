# PDF 知识库（PDF knowledge library）

一个 DeepSeek Harness 插件：上传 PDF → 自动解析成正文与知识条目 → 在左侧边栏里查看、检索、提问；同时把这批知识交给对话中的助手，让它在回答时优先引用你的文档，查不到时明确告诉你「知识库缺少相应知识」。

- 左侧边栏新增一个「PDF 知识库」入口，面板可上传、查看正文、浏览知识条目、直接提问
- 解析完全在本机完成（自研纯 JS 解析器，不联网、不上传第三方服务）
- 给助手注册 11 个工具 + 一段系统提示，对话里也能问答、增删文档、整理分组
- 零构建、零运行时依赖，只装一个包

## 功能

| 面板页签 | 作用 |
| --- | --- |
| 文档 | 拖放或选择 PDF 上传；文档按自定义分组折叠展示（标题、页数、知识条目数），可在分组间移动、重命名或删除分组 |
| 内容 | 逐页查看解析出的正文，用来核对解析是否符合预期 |
| 知识 | 按主题（章节）分组查看真正参与检索的知识条目，可折叠、可按关键词筛选；分块与页眉页脚、装饰线、断行残字在入库前已被清掉 |
| 提问 | 输入问题，得到基于知识库的答案并标注出处；库里没有相关内容时明确提示 |
| 任务 | 后台任务列表：批量导入与扫描件识别的进度、成功/失败数量、可取消或清除 |

批量上传：一次选择（或拖入）多个 PDF，面板会创建一个后台任务，逐个把文件送到宿主进程排队解析；解析在后台进行，关掉面板、切到别的页面都不会中断，回到「任务」页签即可看进度。单文件也会走同一条队列，界面上只是任务里只有一个文件。

文档分组：左侧「+ 新建分组」可建任意分组（例如「算法书」「产品文档」「合同」），每篇文档下方的下拉框可随时把它移到别的分组或「未分组」；分组标题右侧可重命名或删除，删除分组只会把里面的文档放回「未分组」，不会删文档。分组只保存在本地索引里，不改变文档本身。

扫描件（图片型 PDF）也能导入：页面图像会保存下来并标记为「待识别」，点一次「识别扫描页」后交给后台任务连续分批识别（每批 40 页），识别出的文字直接参与检索与提问。

对话里的工具：

| 工具 | 用途 |
| --- | --- |
| `kb_search` | 按关键词/问题检索知识库，返回片段、出处与覆盖度 |
| `kb_documents` | 列出当前知识库里的文档（含主题数、待识别扫描页数） |
| `kb_topics` | 列出某篇文档的知识按主题（章节）的分组与页码范围 |
| `kb_read_document` | 读取某篇文档（可按页码）的正文 |
| `kb_add_document` | 用本机绝对路径把一份 PDF 加入知识库（支持扫描件） |
| `kb_import` | 用本机路径**批量**导入 PDF，交给后台队列，立即返回任务 id |
| `kb_ocr` | 识别某篇文档的扫描页，分批推进并报告剩余页数 |
| `kb_jobs` | 查看后台导入/识别任务的进度与失败原因 |
| `kb_groups` | 列出文档分组，以及每个分组里的 PDF 与未分组的 PDF |
| `kb_move_document` | 把一篇文档移入某个分组（分组不存在会自动创建），传空分组名则移出分组 |
| `kb_remove_document` | 从知识库删除一篇文档 |

## 安装

要求：DeepSeek Harness（桌面版或 `dsh` 命令行）已安装并能打开 Web GUI。

### 方式一：从 Git 地址安装（推荐）

左侧边栏 → **Plugins** → **Add plugin** → 选择 *Install a third-party plugin*，填入：

```
https://github.com/LazyZou/dsh_knowledge_base.git
```

安装完成后点 **Enable now**。

### 方式二：本地目录安装

```bash
git clone https://github.com/LazyZou/dsh_knowledge_base.git
```

然后在 **Plugins → Add plugin** 里填这个克隆目录的**绝对路径**（例如 `D:\tools\dsh_knowledge_base`），安装后点 **Enable now**。

### 方式三：让助手代装

对 DSH 里的助手说「安装 D:\tools\dsh_knowledge_base 这个插件」，它会调用 `plugin_manager` 的 `install_bundle`。

安装或升级后如果侧边栏没变化，刷新一次浏览器页面（`Ctrl/Cmd + R`）；替换已安装的包时可能需要重启 DSH。

## 使用

1. 点左侧边栏的 **PDF 知识库**。
2. 把 PDF 拖到面板里（可多选），或点「批量上传 PDF」。文件先传上去，再在后台排队解析：进度在 **任务** 页签里，每份文件显示成功/失败；重复上传同一文件会自动去重（按内容哈希）。
3. 切到 **内容** 核对正文、切到 **知识** 按主题看分块（可折叠、可筛选），任何一块都能看到它来自第几页。
4. 切到 **提问** 问一个文档里有的问题 → 应给出答案并标注 `[文档标题 · p.页码]`；再问一个文档里没有的 → 应提示「知识库缺少相应知识」。
5. 上传扫描件时，页面会以「待识别」入库：批量导入默认顺带识别；也可以单独在 **内容** 页点「识别扫描页」，它会创建一个后台识别任务连续分批跑到完成，进度同样在 **任务** 页，随时可以取消；识别完可以在 **知识** 页看到新生成的分块。
6. 在普通对话里也可以直接问，助手会先检索知识库再回答，并引用出处；遇到待识别的扫描件它会先调用 `kb_ocr`。

### 扫描件识别用的是什么

按「本机优先、模型兜底」两级：

1. 装了 **Tesseract** 就直接调用本机二进制（不消耗 token、不联网），自动探测常见安装路径，并优先用 `chi_sim+eng`。中文扫描件需要 `chi_sim` 语言包：

   ```bat
   :: Windows：装完 Tesseract 后把 chi_sim.traineddata 放进 tessdata
   :: https://github.com/tesseract-ocr/tessdata/blob/main/chi_sim.traineddata
   copy chi_sim.traineddata "C:\Program Files\Tesseract-OCR\tessdata\"
   ```

2. 没装 Tesseract 时，调用视觉插件提供的 `vision_ocr` 工具，由视觉模型识别页面图像（会消耗 token）。

两种都没有时会明确报「没有可用的识别后端」，不会把空结果写入知识库。为了省钱又准：只识别没有文字层的页；本机 Tesseract 用原始分辨率（字形更清楚、中文错字更少），同一个页面另存一份缩到 1600 像素宽的副本专供视觉模型（图像 token 约为原图四分之一）；识别结果落盘缓存；同一文档里完全相同的页面只识别一次；多页并行识别（默认 4 路，可调），每次调用只处理有限页数。

### 解析失败怎么办

| 提示 | 原因 | 处理 |
| --- | --- | --- |
| 需要口令才能打开 | PDF 有打开密码或口令加密 | 用阅读器另存为无密码副本后重新上传 |
| 不支持 AES-256 加密 | 只支持 RC4 / AES-128 的空口令文档 | 同上，另存为无加密副本 |
| 没有可用的识别后端 | 本机没有 Tesseract，也没有可调用的视觉工具 | 装 Tesseract（推荐，零 token），或在开启视觉的会话里让助手识别 |
| 视觉后端暂时不可用 | 视觉模型超时或被限流 | 过一会儿重试；装 Tesseract 可完全避开网络 |
| 无法识别该页面图像 | 扫描页用了 JPEG2000 / JBIG2 编码 | 用阅读器导出为普通图片型 PDF 或先转成文字型 PDF |
| 文件不是有效的 PDF | 损坏或不是 PDF | 检查文件头 `%PDF` |
| 文件超过 500 MB | 单文件上限 | 拆分后分别上传 |

## 数据存放

全部数据在本机，位置为 `$DSH_HOME/pdfkb`（`DSH_HOME` 未设置时是 `~/.dsh/pdfkb`，Windows 通常是 `C:\Users\<你>\.dsh\pdfkb`）：

```
pdfkb/
├── index.json           # 文档清单与统计（含待识别页数）
├── jobs.json            # 后台任务队列与进度（最近 20 个）
├── docs/<id>.json       # 单篇文档：逐页正文 + 识别出的文字 + 按主题分组的知识分块
├── docs/<id>/p1.png     # 扫描页的页面图像（原始分辨率，识别与预览用）
│   └── p1.vision.png    # 供视觉模型使用的缩小副本（装了 Tesseract 时不生成）
└── tmp/                 # 上传暂存，处理完即删除
```

删除这个目录即可清空知识库；插件本身不需要任何外部服务。

## 文本清洗与主题分组

解析出的文字会先过一遍清洗，再决定是否入库：

- 丢掉页眉页脚与页码（`- 12 -`、`Page 12 of 300`、`第 12 页`）、装饰线（`-----`、`=====`、`······`）、纯符号行、零宽字符与控制字符、缺字形的私有区字符与替换符 `�`。
- 丢掉连续重复的行（每页重复的页眉），把 `A，B` 这类被 PDF 拆行造成的碎片重新拼成一段。
- 丢掉每页重复的页眉页脚（如每页顶端的 `第 17 章 图性质和类型`），只保留首次出现的章节标题，避免同一行反复进入检索结果。
- 丢掉目录行（`18.9 图算法的分析 ...... 103` 这类点线引导行）与 OCR 在点线上生成的伪文字（`sesenecesscesences…`、`eee reer rere`），它们不承载知识，还会污染主题名。
- 清洗后不足 32 个有效字符的片段不写入知识库，避免「无意义的文本」占掉检索名额。

每个分块带一个**主题**：文档按顺序扫描，遇到章节标题（`第 3 章 图`、`2.2.3 部署`、`Chapter 4`、`二、安装部署`）就开一个新主题，后续正文归到该主题下；标题判定会避开行号、代码行与配置项（含 `=`、`{`、`//` 的行不算标题）。同一章的不同写法（`第 19 章 AHA DAG`、`第 19 章 _ 有向图和 DAG`）按章号合并成一个主题，同一节号的不同写法按节号合并，显示时取出现次数最多的那种写法，所以不会因为 OCR 抖动切出几十个同义主题。没有章节标题的文档退化为「按高频词分组」，仍不会变成上百个一条的主题。

升级前入库的文档会在下次打开时按新规则**自动重建**分块与主题，不需要重新上传（OCR 结果会保留）。

## 解析与检索是怎么做的

- **PDF 解析**：`lib/pdf.mjs`，纯 JS + Node 内置 `crypto`/`zlib`。支持交叉引用表与对象流（ObjStm）、跨页继承的资源字典、Form XObject 递归、`Tj`/`TJ`/`'`/`"` 文本操作符、ToUnicode CMap（含 `bfchar`/`bfrange`）、Identity-H 双字节编码、WinAnsiEncoding，以及 Standard handler 空口令下的 RC4 与 AES-128 解密。
- **页面图像**：解析时顺带记录每页最大的图像 XObject；DCTDecode 直接取出原始 JPEG，8 位灰度/彩色 FlateDecode 与 CCITT G3/G4 传真编码（扫描件最常见）用 zlib 重新编码为 PNG，只对没有文字层的页落盘。
- **OCR**：`lib/ocr.mjs`，先试本机 Tesseract（`chi_sim+eng`，原始分辨率，超时可中断），再用 `vision_ocr` 工具走视觉模型（1600 像素宽的副本）；都不可用时返回 `OCR_UNAVAILABLE`。多页并行识别，默认 4 路。
- **文本清理**：Tesseract 输出的中文会在字间插空格，识别后会把汉字之间、以及汉字与中文标点之间的空格去掉，并把夹在中文之间的半角标点转成全角，避免影响分词与检索。
- **分块**：约 900 字符一块、120 字符重叠，按页记录来源；识别出的页文字与原生文字一样参与分块。
- **检索**：BM25（`k1=1.2`、`b=0.75`），对英文按词、对中文按单字加二元组分词。
- **后台任务**：`lib/jobs.mjs` 把批量导入与扫描件识别记录成持久化任务（`jobs.json`），宿主进程用一个串行队列逐个处理：文件先流式落盘，再解析入库；任务状态、每份文件的结果都写盘，刷新页面或重启 DSH 后仍能看到，并在重启时把中断的任务重新排队。
- **回答**：抽取式——命中覆盖度低于阈值（0.34）时直接判定「缺少相应知识」，否则从命中最高的片段里挑出与问题最相关的句子并标注出处。面板内的问答不调用大模型，因此离线可用、结果可复现；需要更强的组织性回答时，在对话里问助手（它拿到同样的检索结果再组织语言）。

## 已知限制

- 扫描件可入库，但识别质量取决于页面图像：手写体、低分辨率、倾斜页面容易出错；JPEG2000 / JBIG2 编码的页面暂不支持（JPEG、Flate 位图、CCITT G3/G4 传真编码都支持）。
- 有打开密码、或使用 AES-256 加密的 PDF 不支持。
- 多栏排版、跨页表格的阅读顺序可能与视觉顺序不一致。
- 中文分词是字/二元组级别，长文档里的近义表述召回一般；关键词命中更可靠。
- 分块检索面向「找得到出处」，不适合需要通读全文的长链条推理。
- 单文件上限 500 MB；PDF 解析需要整份文件驻留内存，超大文件建议拆分。

## 开发

无需构建步骤：`index.js` 是 Host 半（`export function apply(ctx)`），`client.js` 是浏览器半（`window.__ModuleLoader__.load`），`lib/` 是纯 ESM 模块。

```
pdf-kb/
├── index.js            # Host：/api/pdfkb/* 路由、11 个工具、系统提示
├── client.js           # Client：侧边栏入口 + 主面板页面
├── cordis.patch.yml    # bundle patch（一行 insert）
├── lib/pdf.mjs         # PDF 文本抽取 + 页面图像
├── lib/ocr.mjs         # 扫描页识别（Tesseract / 视觉工具）
├── lib/store.mjs       # 分块 + BM25 检索 + 落盘
├── lib/jobs.mjs        # 后台任务队列（批量导入 / 扫描件识别）
├── locale/{zh,en}.json # 插件显示名与说明
├── docs/DETAIL.md      # Plugins 页里的详情文档
└── icon.svg
```

改完 Host 代码后，把插件在 Plugins 页开关一次（off → on）即可热重载，无需重启。

## English

A DeepSeek Harness plugin that turns PDFs into a local knowledge base: upload documents in a sidebar panel, inspect the extracted text and knowledge chunks, ask questions answered with citations, and let the chat assistant search the same library through `kb_search` / `kb_documents` / `kb_read_document` / `kb_add_document` / `kb_import` / `kb_ocr` / `kb_jobs` / `kb_remove_document`. Batch imports and scan recognition run as persistent background jobs with visible progress. Parsing is done in-process in pure JavaScript (no network, no external service). Install from the Plugins page with the repository URL or a local checkout path.

## License

MIT © 2026 LazyZou
