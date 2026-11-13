# 实现计划：选中图层拼图导出（1.3.0）

依据：`.dsh/specs/2026-11-12-layer-collage.md`（用户已在 Claude Code 确认，规格为唯一依据）。

## 1. 目标与完成定义

在「范围」里新增第三个模式 **拼图**：把 Photoshop 当前选中的图层 / 组按网格拼成**一张**图导出，
用户可设列数与目标尺寸（只缩不放）。选择读取、排序去重、依赖跳过、隔离显示全部复用
「选中图层」模式；导出命名 / 编号 / 目录 / 格式 / JPG 质量复用 1.2.0。

完成定义 = 规格「验收标准」1–6 全部满足，`feat/collage` 推送到 origin，报告实现文档 / 测试结果 / commit。

## 2. 技术方案

### 2.1 总原则

- 规则只写一份：网格数学放 `jsx/core.jsx`（ES3 纯函数），面板与宿主共同调用。
- 选择读取 / 去重 / 依赖判断 / 隔离显示**不另写**：把 `previewSelectedLayers` /
  `exportSelectedLayers` 的前半段抽成共享 helper，两处调用。
- 面板在浏览器里也能调用 `QPECore`：`index.html` 在 `panel.js` 之前加载 `jsx/core.jsx`
  （纯 ES3，无 ExtendScript 依赖，末尾 `module.exports` 有 typeof 守卫）。

### 2.2 新增 QPECore 纯函数（`jsx/core.jsx`）

| 函数 | 行为 |
| --- | --- |
| `collageAutoColumns(count)` | `count <= 0 → 0`，否则 `ceil(sqrt(count))` |
| `collageRows(count, columns)` | `count <= 0 || columns <= 0 → 0`，否则 `ceil(count / columns)` |
| `normalizeCollageColumns(value, count)` | 返回 `{columns, clamped}`；解析整数（≤0 / 非数按 1），夹到 `[1, max(1,count)]`；`clamped = 原值 > count && count > 0` |
| `collageOriginalSize(columns, rows, docWidth, docHeight)` | `{width: columns*docWidth, height: rows*docHeight}` |
| `resolveCollageTarget(origW, origH, widthInput, heightInput)` | 见下 |

`resolveCollageTarget`：
- 输入 `null / undefined / ""` 视为未填；否则四舍五入为整数，非数 / ≤0 → `{ok:false, code:"TARGET_INVALID", message:"目标尺寸必须是大于 0 的整数"}`。
- 都未填 → `{ok:true, width:origW, height:origH, source:"original"}`。
- 填了宽（或宽高都填，宽优先）：`targetW = round(widthInput)`；`targetW > origW` → `{ok:false, code:"TARGET_UPSCALE", message:"目标尺寸不能大于原始拼图尺寸（origW×origH）"}`；`targetH = max(1, round(targetW * origH / origW))`。
- 只填高：同理反向算宽。
- 返回 `{ok:true, width, height, source:"width"|"height"|"original"}`。

所有函数挂到 `QPECore`，并补 `module.exports` 与 Node 单测。

### 2.3 宿主接口（`jsx/host-body.jsx`）

新增两个 METHOD，原有方法签名与返回不变。

**共享 helper（重构，不改变现有行为）**
`collectSelection()`：
```
{doc, selection:{ids}, index, resolved:{targets}, exportable:[record], knownSkips:[{id,name,isGroup,code,message}]}
```
把 `previewSelectedLayers` 的 NO_DOCUMENT → 选择读取 → 建树 → 去重 → `dependencyFor` 拆分
原样搬入；`previewSelectedLayers` / `exportSelectedLayers` 改为调用它（行为断言以现有测试为准）。

**`previewCollage(args)`**
args：`{prefix, digits, folder, format, quality, numbering}`（与 previewSelectedLayers 相同）
返回：
```
{ok:true, document, documentWidth, documentHeight, selectionKey, selectedCount, count,
 items:[{id,name,isGroup}], skipped:[{id,name,isGroup,code,message}],
 folderAvailable, fileName, startNumber, maxNumber, existingCount, warnings}
```
- `fileName` 用 `buildBatchNames(files, prefix, digits, 1, true, options)` 的 `names[0]`；未选目录时假设 `-01`。
- `warnings` 与批量预览相同的转换提示（复用同一个 helper）。

**`exportCollage(args)`**
args：`{prefix, digits, folder, format, quality, numbering, columns, targetWidth, targetHeight, selectionKey}`
流程：
1. 校验（NO_DOCUMENT / 前缀 / 位数 / 质量 / NO_FOLDER / FOLDER_MISSING / FOLDER_NOT_WRITABLE），
   读选择、去重、拆分跳过、比对 `selectionKey`（不一致 → `SELECTION_CHANGED`）。
2. `count === 0` → `NOTHING_TO_EXPORT`「没有可导出的对象：全部被跳过，未导出。」（附 skipped）。
3. `columns = normalizeCollageColumns(args.columns, count).columns`；`rows = collageRows(count, columns)`；
   `original = collageOriginalSize(columns, rows, doc.width, doc.height)`。
4. 原尺寸任一边 > 300000 → `COLLAGE_TOO_LARGE`（附 `columns/rows/originalWidth/originalHeight`）。
5. `resolveCollageTarget(...)`，失败 → 透传 `TARGET_UPSCALE / TARGET_INVALID`。
6. 保存 `app.displayDialogs`；`workDoc = doc.duplicate(BATCH_TEMP_NAME)`，转 8 位 RGB。
   源 doc 分辨率保持；拼图文档也用同一分辨率（见下），避免跨分辨率粘贴缩放。
7. 新建拼图文档：
   `app.documents.add(UnitValue(origW,"px"), UnitValue(origH,"px"), doc.resolution, COLLAGE_TEMP_NAME, NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT)`。
8. 按 `resolved.targets` 顺序逐项：
   - `dependencyFor` → 记入 skipped，不占格子；
   - 恢复可见性快照、隔离目标；
   - 把 workDoc 存成临时 PNG（`uniqueTempFile(".png")`）；
   - `app.open` 该 PNG：活动层 `bounds` 宽高为 0 → 关闭、删临时文件、记 `EMPTY`
     「完全透明，已跳过（不占格子）」，**不放格子**；
   - 否则把该层 `duplicate(collageDoc, ElementPlacement.PLACEATBEGINNING)`，
     `translate(cellX - bounds[0], cellY - bounds[1])` 放到 `col = placed % columns`、
     `row = floor(placed / columns)` 的格子原点；关闭探测文档、删临时文件；`placed++`。
   - 临时文档 / 临时文件全部登记，`finally` 清理。
9. `placed === 0` → 关闭拼图文档，`NOTHING_TO_EXPORT`，不写输出文件。
10. 目标尺寸与原始不同 → `collageDoc.resizeImage(UnitValue(targetW,"px"), UnitValue(targetH,"px"), resolution, ResampleMethod.BICUBICSHARPER)`（只缩一次；实测若不如 BICUBIC 再定）。
11. JPG → `fillWhiteAndFlatten(collageDoc)`（透明处与末尾空格统一白底）；PNG 保持透明。
12. `nextFreeTarget` → `saveAs(..., saveOptionsFor(format,quality), true, Extension.LOWERCASE)`，
    校验存在且 `length > 0`；关闭拼图文档（DONOTSAVECHANGES）；恢复活动文档 / displayDialogs。
13. 返回：
```
{ok:true, code:"OK", message:"拼图导出完成"(+跳过数), fileName, fullPath,
 width, height, columns, rows, placedCount, total, skipped, warnings, converted,
 cleanupErrors, document, originalWidth, originalHeight, number}
```
失败返回 `fail(code, message, extra)`，绝不留下半成品输出文件或临时文档。
拼图模式**不做**文件大小预估。

### 2.4 面板（`index.html` / `css/style.css` / `js/panel.js` / `js/cep-bridge.js`）

`index.html`
- 范围 `.seg#mode` 增加 `<button data-mode="collage">拼图</button>`。
- 新增 `#collage-box.hidden`（只在拼图模式显示）：
  - 列数行：`<span class="label">列数</span><input id="collage-columns" type="number" min="1" step="1">` + 网格提示 `#collage-grid`（如 `6 张 → 3 列 × 2 行`）。
  - 原始尺寸：`#collage-original`（如 `1200 × 800 px`）。
  - 目标尺寸行：`#collage-width`、`#collage-height`（`type="number" min="1" step="1"`，placeholder 留空=原始），中间 `×`，单位 `px`。
  - `#collage-size-hint`：`原始 1200 × 800 → 导出 300 × 200` / 放大警告 / 列数被夹提示。
  - `#collage-list`：对象与跳过项列表（复用 `.selection-list` 样式）。
- `jsx/core.jsx` 在 `js/cep-bridge.js` 之前加载（全部为纯 ES3 函数；`module` 有 typeof 守卫）。
- 高度仍在面板滚动范围内，`CSXS/manifest.xml` 几何不改。

`js/panel.js`
- `STORAGE_KEYS.collageColumns = "qpe.collageColumns"`；`state` 增加 `collageColumnsEdited`（null 表示自动）、`collageCount`、`collageDocWidth/Height`、`collageSelectionKey`、`collageTargetWidth/Height`、`collageTargetDriver`（"width"|"height"|null）。
- `restoreState` / mode 点击允许 `collage`；切出 `document` 时 `invalidateEstimate`；`renderMode` 控制 `#selection-box` / `#collage-box`；状态提示按模式区分。
- `renderFormat`：`selection` 与 `collage` 都隐藏 `#estimate-row`。
- `exportLabel`：collage → busy ? "正在导出拼图…" : "导出拼图 " + formatName；selection 保持原文案。
- `updatePreview` 分派 `collage → updateCollagePreview`（`CEPBridge.call("previewCollage", scanArguments())`）。
- `updateCollagePreview(result)`：
  - 保存 selectionKey / count / 文档宽高；
  - **选择或文档变化时清空目标宽高与 driver**（比较旧 selectionKey / docKey）；
  - 有效列数 = `normalizeCollageColumns(edited ?? collageAutoColumns(count), count)`；
  - 回写列数输入（用户正在输入时不强改）、`#collage-grid`、`#collage-original`；
  - `#collage-list` 列出可导出对象（`· name`）与跳过项（`× name：message`）；
  - `#next-file` 显示 `result.fileName`；0 个可导出时给明确提示（全部跳过）；
  - 调 `renderCollageSizeHint()`。
- 列数事件：`input` 用于即时重算（不写回、不存）；`change` 时归一化、写回、`storeSet("qpe.collageColumns")`、`collageColumnsEdited = 值`（等于自动值时仍视为手动，规则简单）。
- 目标宽 / 高事件：`input` 时设 driver，另一个输入框自动填 `resolveCollageTarget` 结果；两框都清空 → 恢复原始尺寸；放大 / 非法 → 红色提示且导出前拦截。目标尺寸只放内存，不写 localStorage；选择 / 文档变化清空。
- `doExportCollage`：校验前缀、目录、selectionKey、目标尺寸；`setBusy`；`CEPBridge.call("exportCollage", {..., columns, targetWidth, targetHeight, selectionKey})`；`SELECTION_CHANGED` 提示刷新；`renderCollageResult` 显示文件路径、最终像素尺寸、实际放入数、跳过列表、转换警告；更新预览 / 文档状态。
- `setBusy` 同时禁用拼图输入与列数；导出按钮文案走 `exportLabel`。
- 0 个可导出时允许点击，由宿主返回 `NOTHING_TO_EXPORT` 并在状态区说明。

`js/cep-bridge.js`（mock）
- `mockPreviewCollage`：mock 文档 1080×1920，选中 6 个、可导出 5 个（1 个依赖跳过），
  `fileName` 按 mock 目录现有 `-01.png`/`-03.jpg` 共用序列算出 `-04.png`；`documentWidth/Height`。
- `mockExportCollage`：校验 folder / selectionKey / 放大；返回 `fileName/fullPath/width/height/columns/rows/placedCount/skipped`；不改 mock 目录（避免影响其它 mock 断言时在断言里说明）。
- `mockDispatch` 增加两个方法。

### 2.5 版本与文档
- `package.json`、`CSXS/manifest.xml`（`ExtensionBundleVersion` 与 `/Extension` Version 两处）→ `1.3.0`。
- `README.md`：模式说明增加「拼图」；使用步骤、列数 / 目标尺寸 / 只缩不放、JPG 白底、限制；面板截图若变化更新（新增拼图模式截图）。
- `docs/design.md`：新增「拼图导出（1.3.0）」章节（网格数学、合成流程、临时文件清理、错误码、面板 / mock）。
- `docs/acceptance.md`：新增 1.3.0 验收记录（自动化项数、真机检查表、像素检查、视觉截图、未验证项）。
- `.dsh/specs/2026-11-12-layer-collage.md` 随实现一起提交。

### 2.6 合成方式（实测决定）
主方案：**临时 PNG + 图层 duplicate**（上面第 8 步）。理由：像素位置可精确控制
（`translate` 到格子原点）、透明 alpha 由 PNG 保真、不依赖剪贴板 / 跨文档粘贴位置，
且复用批量导出的「保存后重开判空」路径。若真机实测 duplicate 跨文档出现缩放或坐标异常，
退路是「临时 PNG 文档全选复制 → 拼图文档粘贴 → 按 bounds 平移到格子原点」；两者都用探针实测
像素后再定，最终写入 `docs/design.md`。

## 3. 实施步骤（写作用域）

1. **计划落盘**（本文件，Lead）。
2. **core 数学 + 单测**（Lead；`jsx/core.jsx`、`tests/core.test.mjs`）：5 个函数 + 全部验收单测，
   `node --test` 绿。
3. **面板 UI + mock**（子代理 panel-dev；`index.html`、`css/style.css`、`js/panel.js`、
   `js/cep-bridge.js`、`tests/panel*.test.mjs`）：按 2.4 实现；Chrome 直接打开可交互；
   更新 VM 面板测试（bootPanel 增加新 id，加载 core.jsx），新增拼图交互测试。
4. **宿主拼图**（Lead；`jsx/host-body.jsx`）：共享 helper + `previewCollage` / `exportCollage` +
   METHODS / module 导出。
5. **生成 host.jsx**（Lead；`node scripts/build-host.mjs`），`--check` 通过。
6. **真机探针 + 实现校准**（Lead 独占 Photoshop）：验证 duplicate/translate 像素、JPG 白底、
   缩放质量、16 位 / CMYK，必要时调整方案；探针放 `.tmp/`。
7. **真机验收脚本**（子代理 verify-dev；`tests/photoshop/collage-acceptance.jsx`、
   `scripts/verify-collage-photoshop.ps1`）：按规格验收标准 3 全项 + 像素取样；仿照 jpg 脚本，
   PS 5.1 纯 ASCII。脚本就绪后由 verify-dev 在 Photoshop 上运行并修到全绿（与 Lead 协调 PS 占用）。
8. **浏览器视觉验收**（Lead）：playwright-core 不可用时用 Node 24 内置 WebSocket + Chrome CDP
   驱动本机 Chrome，320×760@2x，截 `.tmp/visual-check/`：拼图默认 / 目标尺寸联动 /
   深色浅色 / 设置区展开；断言 `scrollWidth === clientWidth` 无横向溢出；回归整图 / 选中图层。
9. **回归**（Lead / verify-dev）：`verify-photoshop.ps1`、`verify-batch-photoshop.ps1`、
   `verify-jpg-photoshop.ps1` 全绿。
10. **文档 + 版本**（Lead），构建 `host.jsx` 再 `--check`。
11. **提交 / 推送**（Lead）：从 main 建 `feat/collage`；提交规格 + 实现 + 文档；
    `git -c http.proxy=http://127.0.0.1:10808 push -u origin feat/collage`；不强推、不合并、不打 tag。
12. **报告**：实现文档路径、测试结果（单测 / 浏览器 / 真机 / 回归）、分支与 commit。

## 4. 测试与验收对照

| 规格验收项 | 覆盖方式 |
| --- | --- |
| 1 build-host --check + 全部单测 | 新增 core 单测：自动列数、行数、列数>N、原始尺寸、宽高联动与四舍五入、放大被拒、空输入=原始 |
| 2 浏览器 mock 交互 + 截图 | `.tmp/visual-check/`，深浅主题、无横向溢出 |
| 3 真机全项 | `tests/photoshop/collage-acceptance.jsx` + `scripts/verify-collage-photoshop.ps1`，PS1 用 System.Drawing 读像素：1200×800 每格颜色 / 位置、4×2 末尾透明 vs JPG 白、300×200、放大拒绝、跳过与全跳过、JPG 质量、16 位 / CMYK、源文档不变、无残留、displayDialogs、编号 / 目录 / 不覆盖 |
| 4 1.2.0 无回归 | 三个现有 verify 脚本复跑 |
| 5 README / design / acceptance + 截图 | 文档更新 + 新截图 |
| 6 实现文档 + 推送 | 本文件 + `feat/collage` |

真机脚本还要断言：拼图输出是**一个文件**、编号接续既有序列、`SELECTION_CHANGED`、
内部临时文件（`Folder.temp\qpe-collage-*`）清空、没有多余临时文档。

## 5. 风险与对策

- **大网格内存 / 尺寸**：先校验 300000 px / 边；拼图文档建失败或 resize 失败 → 报错并清理，
  不留半成品。必要时在错误信息里给出原始尺寸。
- **duplicate 跨文档位置 / 缩放不确定**：所有放置都按 `bounds` 计算 `translate`，不假设初始位置；
  探针实测后定稿并写进 design.md。
- **空对象检测时机**：预览无法预知 EMPTY（与批量一致），导出时发现则不放格子、不占编号，
  结果列出原因；网格按预览有效数计算，实际放入数可能更少，末尾空格保留。
- **选择变化**：导出前 `selectionKey` 比对，不一致提示刷新。
- **源文档**：只在 duplicate 副本 / 新建文档上操作，结束恢复活动文档与 displayDialogs。
- **面板 id / 桥接一致性**：`tests/panel.test.mjs` 强制 index.html、panel.js、cep-bridge.js 三方一致，
  新增 id / 方法必须同步。
- **PS 被用户文档占用**：验收脚本沿用安全保护（有其它文档时跳过）——如遇占用，先征询用户后
  再运行，禁止关闭用户文档。

## 6. 交付
- 分支 `feat/collage`（从 `main`），提交包含规格、实现、测试、文档、版本 1.3.0；
- 推送 `FleatherYu/photoshop-quick-png-export`（public），代理 `127.0.0.1:10808`；
- 不合并 main、不打 tag、不发 Release、不强推。
