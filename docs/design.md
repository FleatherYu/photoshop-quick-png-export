# 设计说明

## 为什么是 CEP 而不是 UXP

本机只装了 Photoshop CC 2019（20.0.10），它只支持 CEP（CSXS 9），不支持 UXP。
所以面板按 CEP 9 编写：`CSXS/manifest.xml` 用 `Version="7.0"` 清单，宿主范围
`PHXS [20.0,99.9]`。更新的 Photoshop 接受更老的清单版本，因此同一份代码可以继续用。

## 分层

```
index.html + css + js/panel.js
        │  CEPBridge.call(method, args, cb)
        ▼
js/cep-bridge.js  ── __adobe_cep__.evalScript ──▶  jsx/host.jsx
        │                                              │
        │ 浏览器直接打开时用 mock 后端                   ├─ jsx/core.jsx      纯命名/序号逻辑
        ▼                                              └─ jsx/host-body.jsx Photoshop DOM
   JSON 结果（纯 ASCII）
```

- **规则只有一份**：序号、前缀校验、正则转义、补零、格式扩展名和编号策略全部在
  `jsx/core.jsx`。预览、大小预估和真实导出都调用同一套函数，界面上的「导出名称」
  不会和实际写盘结果分叉。
- **面板只做输入和展示**：`js/panel.js` 不自己算序号，也不构造文件名；它只把
  `{prefix, digits, folder, format, quality, numbering}` 交给宿主，渲染宿主返回的
  `fileName` / `fullPath` / 估算字节数。
- **桥接层**：`js/cep-bridge.js` 负责把参数 JSON 嵌入 `evalScript` 表达式并把返回的
  ASCII JSON 解析回对象。参数里的非 ASCII 字符（中文前缀）在嵌入前全部转成
  `\uXXXX`，避免 CEP 文本编码在 Windows 上把它们弄坏。
- **mock 后端**：在普通浏览器里直接打开 `index.html` 时没有 `window.__adobe_cep__`，
  桥接层改用内存假数据，只为检查布局和交互；面板顶部会显示「未连接 Photoshop」。
  mock 不代表任何真实导出能力。

## 生成 `jsx/host.jsx`

ExtendScript 的 `#include` 在不同 CEP 宿主/路径下解析不可靠，所以不用它。
`scripts/build-host.mjs` 把 `core.jsx` 和 `host-body.jsx` 原样拼接成 `host.jsx`，
加一条 `GENERATED` 头。测试会断言磁盘上的 `host.jsx` 与当前源码拼接结果完全一致，
防止改了源码忘记重新生成。

## 宿主接口

`QPE_call(method, argsJson)` 返回 JSON 字符串（`QPECore.toJson`，纯 ASCII）。
`jsx/host.jsx` 末尾只有这个函数会被 evalScript 调用。

| 方法 | 参数 | 返回要点 |
| --- | --- | --- |
| `status` | `{}` | `hasDocument`、文档名/尺寸/颜色模式/位深/是否已保存、`path`（文档所在文件夹，未保存为空）、`suggestedPrefix`（默认前缀）、`suggestedAdjusted`（是否清洗过） |
| `preview` | `{prefix, digits, folder, format, numbering}` | `fileName`、`nextNumber`、`maxNumber`、`existingCount`、`folderAvailable`；未选目录时给假设的 `-01` 名 |
| `exportImage` | `{prefix, digits, folder, format, quality, numbering}` | `fileName`、`fullPath`、`format`、`quality`、`converted`、`warnings`；失败时 `code` + `message` |
| `exportPng` | 同上（强制 `format: "png"`） | 1.1.0 的旧方法名，保留为 `exportImage` 的别名 |
| `estimateSize` | `{format, quality}` | `bytes`、`format`、`quality`；把当前画面按真实导出的同一套保存参数写入系统临时文件后读 `File.length` 并立即删除，不碰输出目录 |
| `previewSelectedLayers` | `{prefix, digits, folder, format, quality, numbering}` | 批量对象列表、`selectionKey`、`expectedFileName`、`skipped`、`warnings` |
| `exportSelectedLayers` | 同上 + `selectionKey` | 成功 / 跳过 / 失败清单、`counts`、`cleanupErrors` |
| `pickFolder` | `{current}` | `path`；用户取消返回 `canceled: true`（不是错误） |
| `openFolder` | `{path}` | 在资源管理器中打开目录 |

## 默认前缀（取自文档名）

产品上「打开文档后直接选目录、点导出」是最常用路径，所以前缀默认不留空：

- 宿主在 `status` 里用 `QPECore.derivePrefixFromDocument(doc.name)` 算出
  `suggestedPrefix`：去掉已知文档扩展名（`.psd/.png/.jpg/.tif/...`，不误伤
  `poster.v2` 这类名字），删除 Windows 不允许的字符与控制字符，去掉首尾空白，
  去掉结尾句点，超长截到 120 字符；`suggestedAdjusted` 标记是否发生过清洗。
- 面板只在用户**没有手动改过**当前文档的前缀时自动填入；改过之后同一文档内
  不再覆盖。切换到另一条文档时重新按新文档名填入（`state.prefixEdited` 重置）。
- 清洗发生时，前缀输入框下方显示一行提示，说明「已按文档名自动填入，并去掉了
  文件名不允许的字符」，不静默改。
- 自动填好的前缀仍然走 `validatePrefix` 校验，保证 `derivePrefixFromDocument`
  的输出永远能直接用于导出（有对应单元测试）。

## 错误码

| code | 场景 | 面板表现 |
| --- | --- | --- |
| `EMPTY` | 空前缀 | 状态区红色提示，不发起导出 |
| `ILLEGAL_CHARS` | 含 `\ / : * ? " < > |` 或控制字符 | 提示具体字符，不静默替换 |
| `TRAILING_DOT` | 前缀以 `.` 结尾 | 提示 |
| `TOO_LONG` | 前缀超过 120 字符 | 提示 |
| `BAD_DIGITS` | 位数不是 1/2/3 | 提示 |
| `BAD_QUALITY` | JPG 质量不是 0–12 的整数 | 提示，不发起导出 |
| `NO_DOCUMENT` | 没有打开的文档 | 「请先打开一个 Photoshop 文档」 |
| `NO_FOLDER` | 没选输出目录 | 提示先选目录 |
| `FOLDER_MISSING` | 目录被删/改名/不可访问 | 提示重新选择 |
| `FOLDER_NOT_WRITABLE` | 目录只读 | 提示换目录 |
| `COLLISION` | 连续 100 次都撞名 | 提示重试，重试会重新扫描 |
| `SAVE_FAILED` / `VERIFY_FAILED` | Photoshop 保存异常 / 结果文件缺失或 0 字节 | 报错，**不显示成功** |
| `ESTIMATE_FAILED` | 估算时无法创建/写入/读取临时文件 | 预计大小显示「无法估算」，不阻塞导出 |
| `EVAL_ERROR` / `BAD_RESPONSE` / `NO_RESPONSE` | evalScript 层失败 | 报错 |

## 安全设计（这些点都有对应测试或代码路径）

1. **不覆盖**：导出前重新扫描目录；`computeExport` 取 `max + 1`；即使扫描后文件被
   外部创建，循环里还会用 `File.exists` 检查并继续加一，最终写入前再查一次。
2. **不改源文档**：`saveAs(..., asCopy = true)`；CMYK/16/32 位或 JPG 导出才 `duplicate`
   临时副本，转 8 位 RGB（JPG 再填白并合并图层），导出后 `close(DONOTSAVECHANGES)`；
   不改图层可见性、不合并图层、不改选区。保存期间 `app.displayDialogs = DialogModes.NO`，事后恢复。
3. **失败不假装成功**：保存后校验 `File.exists` 且 `length > 0`，否则报
   `VERIFY_FAILED`；所有异常都转成带 `code` 的 JSON，绝不让面板显示「已导出」。
4. **前缀按字面匹配**：`escapeRegExp` 转义正则元字符；匹配默认不区分大小写
   （Windows 文件系统本身不区分，避免仅大小写不同导致覆盖判定失败）。
5. **不递归、不误判目录**：`folder.getFiles()` 只收 `instanceof File` 的条目，
   正则要求完整匹配 `前缀-数字.png`。
6. **结果 ASCII 化**：`QPECore.toJson` 把非 ASCII 字符转成 `\uXXXX`，中文路径/前缀
   经过 evalScript 回传不会乱码。

## 文件名扫描与编码（实测踩到的坑）

ExtendScript 的 `File.name` 会把非 ASCII 字符做 **UTF-8 百分号编码**：在 Photoshop
CC 2019 里实测，文件 `QPE-测试-05.png` 的 `File.name` 返回
`QPE-%E6%B5%8B%E8%AF%95-05.png`（文件夹、路径本身正常，只有名字被编码）。
如果直接拿它去匹配 `^前缀-(\d+)\.png$`，中文前缀永远匹配不到 → 序号一直从 01
开始、且会误判成「文件已存在」的冲突循环。

处理方式：

- `jsx/core.jsx` 的 `decodePercentName(name)` 用 `decodeURIComponent` 还原（ExtendScript
  和 Node 都提供该函数）；名字里如果有不构成合法转义的 `%`（如 `100%-05.png`），
  decode 会抛错，此时原样返回。
- 还原发生在 `matchSequence` 内部，所以 `preview`、`exportPng` 的扫描都吃到同一份
  逻辑；`listPngNames` 保持返回文件系统的原始名字，不做重复解码。
- 有单测覆盖：`QPE-%E6%B5%8B%E8%AF%95-05.png` → 识别为序号 5，`100%-05.png` 不崩。

## 界面与主题

面板默认 300×360，最小 240×240。1.2.0 起底部多了一个可折叠的「设置」区（默认收起），
展开后高度会增加，仍在 CEP 面板可用范围内。`js/cep-bridge.js` 读取
`getHostEnvironment().appSkinInfo.panelBackgroundColor` 的亮度，在 `body` 上切
`theme-dark` / `theme-light`，颜色全部走 CSS 变量，深色是默认值。

## 图层批量导出（1.1.0）

面板顶部新增模式切换：`整张画面` 用已有的 `preview` / `exportPng`，`选中图层` 用
`previewSelectedLayers` / `exportSelectedLayers`。批量模式读取的是 Photoshop 当前的
图层选择，而不是面板里另外勾选。

### 读取选择（CC 2019 兼容）

ExtendScript DOM 没有「多选图层」属性（`doc.activeLayer` 只返回最后选中的一个）。
宿主用 ActionManager 读取文档描述符，`targetLayersIDs` 列表在 CC 2019 上可靠：
每一项是引用，`getReference(i).getIdentifier()` 得到图层 id，再用 `executeActionGet(ref)`
读出该图层的描述符；按 id 映射到 DOM 图层树（`layer.id` 与 ActionManager 的 id 一致，
组也一样）。`targetLayersIndexes` / `targetLayers` 在旧版本上会漏掉活动图层或返回偏移
索引，只作为不支持 `targetLayersIDs` 的宿主的后备路径。

拿到 id 后遍历 DOM 层树，按面板从上到下排序（父组在子层之前）；同时选中父组和子层时
只保留父组。`previewSelectedLayers` 返回同样的顺序与预计文件名，面板展示给用户。
选择可能随时变化，所以返回一个 `selectionKey`（文档名 + 尺寸 + id 列表），
`exportSelectedLayers` 开始时重算并比对，不一致直接返回 `SELECTION_CHANGED`，
让用户刷新后重试。

### 隔离与导出流程

1. 校验前缀、位数、目录（复用整图导出的校验）。
2. `doc.duplicate()` 一次得到工作副本；源文档不再被触碰，结束时关闭副本并重新激活源文档。
3. 记录副本里所有图层的可见性快照。
4. 按顺序逐项处理：
   - 计算依赖（见下），有跨边界依赖 → 记入 `skipped`，不占编号；
   - 恢复可见性快照，只显示目标对象及其祖先链，组则恢复组内原有的子层可见性；
   - 用 `PNGSaveOptions` 把副本存成目标文件名（`asCopy = true`；先按
     `computeExport` 取 下一个编号，保存前再次确认文件不存在）；
   - 重新 `app.open` 这个 PNG，检查活动图层 `bounds` 面积：面积为 0 说明整张全透明，
     关闭文档、删除文件、记入 `skipped`，编号不前进；否则计入 `successes`。
5. 任一项保存/校验失败：立即停止，保留已成功的文件，返回 `failed` 项和
   `unprocessedCount`（排在后面的对象没有导出）。
6. `finally` 中关闭所有临时文档、恢复 `app.displayDialogs`、恢复源文档为活动文档，
   清理失败只记入 `cleanupErrors`，不掩盖主结果。

> 为什么用「保存后重开 PNG 判空」：ActionManager 的 alpha 直方图、`doc.trim()`、
> flatten 后载入 Trsp、BMP 32 位 alpha、TIFF alpha 在 CC 2019 上全部实测不可行
> （探针记录见 `docs/acceptance.md`）；重开 PNG 的 `bounds` 是唯一稳定可靠的
> 「合成后是否有像素」判据。

### 依赖支持矩阵（首版，保守）

| 情况 | 处理 |
| --- | --- |
| 目标自身是剪贴蒙版内容（`layer.grouped`） | 跳过，`CLIPPED` |
| 目标上方紧邻的剪贴蒙版内容依赖它（外部剪贴基底） | 跳过，`CLIPPED` |
| 目标自身 / 组内 / 祖先的非正常混合模式 | 跳过，`BLEND` |
| 穿透组内部有非正常混合模式（会读组外背景） | 跳过，`BLEND` |
| 目标上方（同层或祖先层）有调整图层 | 跳过，`ADJUSTMENT` |
| 组内部自足的剪贴 / 调整层 | 保留，正常导出 |
| 完全没有像素（空图层、空组、全透明） | 跳过，`EMPTY`，不占编号 |

`adjustment` 分支因为 CC 2019 的 DoJavaScript 无法用脚本创建调整图层（`Mk AdjL`
报「不能完成命令，因为程序错误」），没有真机样例，只在代码层面实现；遇到时行为是
跳过并给出原因，不会导出错误结果。

### 返回值

`previewSelectedLayers`：`document`、`selectionKey`、`selectedCount`（原始选中数）、
`count`（去重后可导出数）、`items`（`id/name/isGroup/expectedFileName`）、`skipped`
（`id/name/isGroup/code/message`）、`folderAvailable`、`startNumber/maxNumber/existingCount`、
`warnings`。

`exportSelectedLayers`：`successes`（`number/fileName/fullPath`）、`skipped`、`failed`
（`name/code/message`）、`unprocessedCount`、`converted`、`warnings`、`cleanupErrors`、
`counts`（由 `QPECore.summarizeBatch` 生成：`exported/skipped/failed/unprocessed/total/allSkipped`）。

### 编号与失败语义

编号在保存前按目录现状计算，只有真正保存成功且非全透明的对象才消费编号；跳过的对象
不占号。所以重跑同一选择会接着目录里的最大编号继续，不会覆盖、不补空洞。整批采用
「失败即停」：不会为了凑满编号继续导出后续对象，面板会显示成功清单、失败项和原因。

### 面板与 mock

`js/panel.js` 用 `state.mode` 记忆模式（`qpe.mode`），预览与导出按模式分派；
选中图层模式下，状态区显示「选中 N 项，去重后 M 项」，导出后展示成功 / 跳过列表。
`js/cep-bridge.js` 的 mock 后端（浏览器里无 CEP 时）提供 `previewSelectedLayers` /
`exportSelectedLayers`，返回固定 3 个选中对象，方便不开 Photoshop 调界面。

## JPG 导出、大小预估与目录跟随（1.2.0）

### 格式与 JPG 质量

- `format` 由 `QPECore.normalizeFormat` 归一到 `png` / `jpg`，扩展名由 `formatExtension`
  给出（小写）。面板记住 `qpe.format`，默认 PNG。
- 质量必须是 0–12 的整数（对应 `JPEGSaveOptions.quality`），`isValidJpegQuality`
  只接受 number；字符串、越界、小数都会被 `BAD_QUALITY` 拒绝，避免把 UI 脏值带进保存。
- JPG 导出永远在副本上做：`prepareCopyForExport` 先按需转 8 位 RGB，再
  `fillWhiteAndFlatten`（有 Background 层则只 flatten；没有则新建白色艺术层置于最底、
  全选填白、取消选区、flatten），因此透明区域是白色，源文档不变。
- 保存参数由 `saveOptionsFor(format, quality)` 统一给出：PNG `interlaced=false`，JPG
  `quality`。大小预估与真实导出共用这个函数，因此两者字节数只差保存开销（实测 ≤16 字节）。
- 转换警告只在源文档真的需要转换时出现；普通 RGB / 8 位文档导出 JPG 不显示
  「颜色可能有偏移」的噪音提示。

### 大小预估

- `estimateSize` 不写输出目录：调用 `uniqueTempFile` 在 `Folder.temp` 创建
  `qpe-estimate-*` 文件，按真实导出的同一套副本 / 填白 / 保存流程写入，读
  `File.length` 后立即删除；`finally` 中恢复 `displayDialogs`。输出目录在估算前后
  文件列表不变。
- 面板端用 token 并发控制：`invalidateEstimate` 每次递增 `estimateToken`，只接受最新
  一次响应；导出期间不发起估算，正在估算时开始导出会让旧结果作废。
- 触发点：切换格式、JPG 质量滑块松手（`change`，拖动中的 `input` 只更新数字）、
  文档指纹变化（轮询发现尺寸 / 模式 / 位深 / 图层数变化）、切回整图模式。同一格式 /
  质量 / 文档组合命中缓存时直接复用文本，不重复临时保存。
- 仅整图模式显示；选中图层模式的张数、跳过项与预估大小无关，因此隐藏该行。
- 显示形态：`正在估算…` → `约 X MB`；失败显示 `无法估算`，导出按钮不受影响。
  `formatBytes` 对 MB 保留 1 位小数，小于 1 MB 用 KB，小于 1 KB 用 B。
- 导出开始会清掉进行中的估算，避免在 Photoshop 忙于保存时再插一次临时保存。

### 编号策略

`computeExport` / `computeNext` / `buildBatchNames` 都接受 `options = {format, numbering}`：

- `shared`（默认）：匹配 `前缀-数字.png`、`前缀-数字.jpg`、`前缀-数字.jpeg`，取全局
  最大编号 +1，下一张用当前格式的扩展名；
- `separate`：只匹配当前导出格式的扩展名（PNG 看 `.png`，JPG 看 `.jpg/.jpeg`），
  各自计数；
- 正则仍要求完整匹配并默认大小写不敏感，`decodePercentName` 也在 `matchSequence` 内，
  中文前缀在两种策略下都能正确计数；`buildFileName` 的第 4 个参数决定扩展名。

### 默认输出目录（跟随文档）

面板状态机（`js/panel.js`）：

- 存储 `qpe.folderMode`（`document` 默认 / `last`）、`qpe.folder`、`qpe.lastFolder`。
- 每次 `status` 轮询得到 `docKey = 文档名|文档路径` 和
  `documentFingerprint = name|宽|高|模式|位深|图层数`。
- `docKey` 变化（切换文档）时清掉「手动选择」标记 `folderEdited`，再应用目录策略：
  - `last` 模式：不动当前目录，只沿用上次导出目录；
  - `document` 模式且文档已保存（`status.path` 非空）：使用文档所在文件夹；
  - `document` 模式且文档未保存：退回 `lastFolder`（上次使用的位置）。
- 同一文档内手动选目录会置 `folderEdited = true` 并记住，轮询不会覆盖；切换文档后
  重新按策略应用。
- 目录来源在路径下方以小字标注（文档所在文件夹 / 手动选择 / 上次使用的位置），不可写
  目录原样显示，导出时仍走 `FOLDER_NOT_WRITABLE` 错误。
- 导出成功后把当前目录写入 `lastFolder`，供未保存文档和 `last` 模式使用。

### 批量 JPG 的判空

PNG 批量可以用「保存后重开 PNG 看 bounds」判空，但 JPG 没有 alpha，透明内容会被填白，
无法再判断是否为空。所以 JPG 批量分两步：

1. 先把隔离后的工作副本存成临时 PNG，`app.open` 后读活动图层 `bounds`；面积为 0 →
   跳过，不占编号、不写输出文件；
2. 非空时在同一个探测文档上填白 + flatten，再用当前编号保存 JPG 到输出目录；
   `finally` 删除临时 PNG、关闭探测文档、恢复活动文档与 `displayDialogs`。

这样空图层 / 空组在 JPG 模式下同样不消费编号，也不会在输出目录留下占位文件。

### mock 与测试

`js/cep-bridge.js` 的 mock 同步支持 `exportImage` / `estimateSize` 和格式 / 编号参数：
种子目录有 `示例海报-01.png`、`示例海报-03.jpg`，JPG 预估用确定的像素公式，方便不开
Photoshop 检查 UI 与两种编号策略。`tests/panel-folder.test.mjs` 用可编排的假桥接验证
目录跟随状态机；真机场景（质量差异、预估一致、透明填白、批量跳过、displayDialogs 恢复）
由 `tests/photoshop/jpg-acceptance.jsx` 覆盖。
