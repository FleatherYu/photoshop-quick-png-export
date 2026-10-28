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

- **规则只有一份**：序号、前缀校验、正则转义、补零全部在 `jsx/core.jsx`。
  预览和真实导出都调用同一套函数，界面上的「下一个文件」不会和实际写盘结果分叉。
- **面板只做输入和展示**：`js/panel.js` 不自己算序号，也不构造文件名；它只把
  `{prefix, digits, folder}` 交给宿主，渲染宿主返回的 `fileName` / `fullPath`。
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
| `status` | `{}` | `hasDocument`、文档名/尺寸/颜色模式/位深/是否已保存、`suggestedPrefix`（默认前缀）、`suggestedAdjusted`（是否清洗过） |
| `preview` | `{prefix, digits, folder}` | `fileName`、`nextNumber`、`maxNumber`、`existingCount`、`folderAvailable`；未选目录时给假设的 `-01` 名 |
| `exportPng` | `{prefix, digits, folder}` | `fileName`、`fullPath`、`converted`、`warnings`；失败时 `code` + `message` |
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
| `NO_DOCUMENT` | 没有打开的文档 | 「请先打开一个 Photoshop 文档」 |
| `NO_FOLDER` | 没选输出目录 | 提示先选目录 |
| `FOLDER_MISSING` | 目录被删/改名/不可访问 | 提示重新选择 |
| `FOLDER_NOT_WRITABLE` | 目录只读 | 提示换目录 |
| `COLLISION` | 连续 100 次都撞名 | 提示重试，重试会重新扫描 |
| `SAVE_FAILED` / `VERIFY_FAILED` | Photoshop 保存异常 / 结果文件缺失或 0 字节 | 报错，**不显示成功** |
| `EVAL_ERROR` / `BAD_RESPONSE` / `NO_RESPONSE` | evalScript 层失败 | 报错 |

## 安全设计（这些点都有对应测试或代码路径）

1. **不覆盖**：导出前重新扫描目录；`computeExport` 取 `max + 1`；即使扫描后文件被
   外部创建，循环里还会用 `File.exists` 检查并继续加一，最终写入前再查一次。
2. **不改源文档**：`saveAs(..., asCopy = true)`；只有 CMYK/16/32 位才 `duplicate`
   临时副本、转 8 位 RGB、导出后 `close(DONOTSAVECHANGES)`；不改图层可见性、
   不合并图层、不改选区。保存期间 `app.displayDialogs = DialogModes.NO`，事后恢复。
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

面板 300×360，最小 240×240。`js/cep-bridge.js` 读取
`getHostEnvironment().appSkinInfo.panelBackgroundColor` 的亮度，在 `body` 上切
`theme-dark` / `theme-light`，颜色全部走 CSS 变量，深色是默认值。
