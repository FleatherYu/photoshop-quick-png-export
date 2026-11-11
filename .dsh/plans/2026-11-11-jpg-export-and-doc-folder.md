# 实现文档：JPG 导出、大小预估、默认目录跟随文档（1.2.0）

- 规格：`.dsh/specs/2026-11-11-jpg-export-and-doc-folder.md`（已由用户在 Claude Code 确认）
- 基线：1.1.0，分支 `main`，commit `55d74f8`
- 目标分支：`feat/jpg-export`（不合并 main、不打 tag、不发 Release、不强推）

## 1. 目标与范围

在既有 PNG 快速导出面板上增加：

1. 导出格式 PNG / JPG 切换；JPG 质量 0–12（默认 10）；透明区域在临时副本上填白。
2. 文档模式下显示「预计大小」，PNG 与 JPG 都支持，估算与实际导出使用完全相同的保存选项。
3. 编号策略设置：共用序列（默认）/ 按格式分开计数。
4. 默认输出目录设置：跟随文档所在文件夹（默认）/ 记住上次位置（1.1.0 行为）。
5. 面板底部可折叠「设置」区，两项设置持久化。
6. 版本号升到 1.2.0，更新 README / docs/design.md / docs/acceptance.md。

不在范围：产品名、扩展 id、仓库名不变；不增加 WebP/GIF 等格式；JPG 渐进式/元数据选项；自定义填底色；不做 Release/tag。

## 2. 关键设计决策

### 2.1 命名与编号（jsx/core.jsx）

纯逻辑保持单一规则源，面板预览与宿主导出共用：

- 新增 `normalizeFormat(value)`（`png`/`jpg`）、`formatExtension(value)`（`.png`/`.jpg`）、`normalizeNumbering(value)`（`shared`/`separate`）。
- 扩展名匹配：
  - 共用序列：`^<prefix>-(\d+)\.(png|jpe?g)$`（大小写不敏感，`.jpg`/`.jpeg` 都计入）。
  - 按格式分开：只匹配当前格式；JPG 同时计 `.jpg` 与 `.jpeg`，PNG 只计 `.png`。
- `buildFileName(prefix, digits, number, format)` 默认 `png`，兼容旧调用。
- `matchSequence / computeNext / computeExport / buildBatchNames` 增加末位 `options = {format, numbering}` 参数；缺省为 `{format:"png", numbering:"shared"}`。`matchSequence` 仍复用 `decodePercentName` 处理 `File.name` 的百分号编码。
- `isValidJpegQuality(value)`：仅接受 number 类型的整数 0–12；`normalizeJpegQuality` 缺省 10。
- 旧测试中「.jpg 不算编号」的断言按新规则更新（共用序列下 .jpg 计入；分开 + PNG 时仍忽略），并新增共用/分开、大小写、`.jpeg`、中文前缀百分号编码用例。

### 2.2 保存与填白（jsx/host-body.jsx）

- 抽出 `saveOptionsFor(format, quality)`：PNG 用 `PNGSaveOptions`（`interlaced=false`）；JPG 用 `JPEGSaveOptions`（`quality` 0–12）。
- 抽出 `prepareCopyForExport(doc, format)`：需要转换（非 RGB / 非 8 位）或 JPG 时 `document.duplicate()`；转换流程沿用 1.1.0 警告文案；JPG 额外在副本最底层加纯白图层、全选填充白色、`flatten()`，再保存。源文档永不被修改。
- `exportImage({prefix,digits,folder,format,quality,numbering})`：完整导出流程（校验 → 可写探测 → 冲突重扫 → saveAs(asCopy) → 校验文件非空），返回结构在 1.1.0 基础上加 `format`。
- `exportPng` 保留为兼容别名（强制 `format:"png"`），现有验证脚本继续可用。
- `estimateSize({format,quality})`：无文档返回 `NO_DOCUMENT`；JPG 质量非法返回 `BAD_QUALITY`；用 `Folder.temp.fsName` 生成唯一临时文件（`qpe-estimate-<time>-<rand>.<ext>`），复用 `prepareCopyForExport` + `saveOptionsFor` 保存，`File.length` 读取字节数，`finally` 关闭副本、恢复 `app.displayDialogs`、删除临时文件；返回 `{ok,bytes,format,quality}`。绝不写入输出目录。
- 批量 JPG 判空：先把隔离后的 `workDoc` 存成系统临时 PNG → 重新打开判 `bounds`；空则关闭并删临时文件（不占号）；非空则在该打开文档上填白 + flatten，保存为输出目录 JPG，关闭并删临时 PNG。空图层/空组不消耗编号，外部依赖跳过逻辑不变。
- `preview / previewSelectedLayers / exportSelectedLayers / exportImage` 均接受 `format`、`numbering`（批量另加 `quality`）；批量预览的 `expectedFileName` 按格式扩展名。

### 2.3 面板（js/panel.js, index.html, css/style.css）

- 新增持久化键：`qpe.format`（默认 png）、`qpe.quality`（默认 10）、`qpe.numbering`（默认 shared）、`qpe.folderMode`（默认 document）。
- UI：格式行（PNG/JPG）；JPG 质量滑条（0–12，实时显示「10 · 高」档位，`input` 只更新显示，`change` 才触发估算）；「预计大小」行（文档模式显示）；目录来源小字（文档所在文件夹 / 上次使用 / 手动选择）；底部 `<details id="settings">` 放编号策略与默认目录两组 segmented 按钮。
- 目录跟随状态机（`refreshDocument`）：
  - 文档标识 `docKey = name|path|WxH`；docKey 变化时重置 `folderEdited`，再按 `folderMode` 应用：有路径 → 该路径（来源 document）；无路径 → `lastFolder`（来源 last）。
  - 手动选目录 → `folderEdited = true`，来源 manual；同一文档内轮询不覆盖。
  - 目录变化都写入 `qpe.folder` 并更新 `lastFolder`；`folderMode=last` 时文档切换不自动改目录（1.1.0 行为）。
  - 面板侧用 `status` 已返回的 `path`（文档所在文件夹）。
- 估算：`estimateSize` 带 token 并发保护；格式/质量/文档指纹（name/尺寸/模式/位深/图层数/saved）变化时标「正在估算…」并重算；过期结果标注「（正在重算…）」；失败显示「无法估算」不阻断导出；`busy` 时取消并跳过；仅整图模式调用。
- 主按钮文案随格式变化（快速导出 PNG / 快速导出 JPG；批量模式文案不变）；错误提示从「PNG 输出文件夹」改为「输出文件夹」。
- 浏览器 mock（js/cep-bridge.js）同步：格式/编号感知的扫描与文件名、`estimateSize` 返回确定性字节数、mock 文档带目录路径以演示跟随文档。

### 2.4 测试与验证

- 单元/面板测试：`node --test --test-isolation=none "tests/*.test.mjs"`；新增 core 编号与质量用例；新增 `tests/panel-folder.test.mjs` 用可控假 `CEPBridge` 覆盖目录跟随状态机；更新 panel-behavior 的 DOM 列表与 panel.test 的标签/ID 约束；manifest/package 版本一致性。
- 真实 Photoshop：新增 `tests/photoshop/jpg-acceptance.jsx` + `scripts/verify-jpg-photoshop.ps1`，覆盖：JPEG 文件头 FFD8FF、透明填白像素、源文档不变、质量 2 vs 12 大小差异、估算与实际一致且无残留、共用/分开编号与不覆盖、选中图层 JPG 空项跳过不占号、已保存 PSD 的 status 路径、16 位/CMYK 转换警告、displayDialogs 恢复；并重跑既有 `verify-photoshop.ps1`、`verify-batch-photoshop.ps1` 确认 PNG 无回归。
- 视觉验收：用本机 Chrome + playwright-core 打开 `index.html`（file://），截 `.tmp/visual-check/` 下深色/浅色、JPG 格式、设置展开的截图供 Claude 审阅。

## 3. 实施步骤

1. 版本号：package.json、CSXS/manifest.xml → 1.2.0。
2. `jsx/core.jsx` 格式/编号/质量纯逻辑 + `tests/core.test.mjs` 更新与新增。
3. `jsx/host-body.jsx`：保存选项、副本准备、exportImage、exportPng 别名、estimateSize、批量 JPG 判空与填白；`node scripts/build-host.mjs`。
4. `index.html` / `css/style.css` / `js/panel.js` / `js/cep-bridge.js`：格式、质量、预估、设置、目录跟随。
5. 面板测试更新与新增；`node scripts/build-host.mjs --check`。
6. 新增真实机 JPG 验收脚本，跑全部 Node 测试与真实 PS 验收。
7. 更新 README.md、docs/design.md、docs/acceptance.md；截图。
8. 提交 `.dsh/specs`、`.dsh/plans` 及全部改动，从 main 建 `feat/jpg-export`，推送 origin。

## 4. 风险与回滚

- 预估耗时：估算在宿主执行，面板保持可用；导出请求在脚本队列中排在估算之后，可接受；估算文件在 finally 删除。
- 批量 JPG 每次多一次临时 PNG 写入/打开，换取判空准确与不占号；临时文件在系统临时目录并在 finally 清理。
- 编号规则变化只影响同前缀目录中已有 JPG 的共用序列场景，纯 PNG 老目录结果与 1.1.0 一致。
- 回滚：所有改动在 `feat/jpg-export` 分支，main 不受影响。
