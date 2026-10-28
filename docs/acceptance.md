# 验收记录

日期：2026-10-28
环境：Windows，Adobe Photoshop CC 2019 20.0.10（CEP 9），Node.js v24.15.0

本文只记录**实际跑过的验证**；没有跑过的项目在文末「未验证」里明确列出。

## 1. 自动化单元测试（全部通过）

```powershell
node scripts/build-host.mjs                                   # 生成 jsx/host.jsx
node --test --test-isolation=none "tests/*.test.mjs"
```

结果：**49 项测试全部通过**（0 失败）。覆盖：

- 前缀校验：空、首尾空白（含全角空格/不换行空格）、非法字符、结尾句点、超长、中文与内部空格；
- 默认前缀：文档名去扩展名（`.psd/.png/...`，不误伤 `poster.v2`）、删除 Windows 非法字符、去首尾空白与结尾句点、超长截断、缺名安全，且清洗结果永远能通过 `validatePrefix`；
- 位数校验与补零：1/2/3 位、默认 2 位、`100` 不截断；
- 文件名与匹配：严格 `前缀-数字.png`、扩展名大小写、正则元字符转义、大小写不敏感；
- 序号：空目录从 01 开始、取最大值 +1、不复用空洞、不同前缀独立、切换位数不重置；
- 中文文件名：`QPE-%E6%B5%8B%E8%AF%95-05.png` 解码后识别为序号 5，`100%-05.png` 不崩；
- `toJson` 纯 ASCII 且中文可往返；`host.jsx` 与源码拼接结果一致；
- 清单 XML 结构、面板 DOM id / 脚本 / 样式与桥接方法一致性；
- `host.jsx` 在裸 Node 上下文可加载，未知方法/坏参数返回 JSON 错误而不是抛异常。

> 说明：`--test-isolation=none` 是因为受限沙箱里 `node --test` 给每个文件起子进程会
> `spawn EPERM`；该参数不影响测试内容。

## 2. 真实 Photoshop 验收（24 项检查全部通过）

脚本：[`scripts/verify-photoshop.ps1`](../scripts/verify-photoshop.ps1)（纯 ASCII，
用 COM 驱动 Photoshop，通过 `DoJavaScript` 加载 `jsx/host.jsx` 并调用 `QPE_call`）。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-photoshop.ps1
```

最后一次完整运行结果（`ALL CHECKS PASSED`，24/24）：

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | 开始时 Photoshop 没有其他文档（保护脚本会在有文档时跳过，见下） | PASS |
| 2 | `status` 报告 800×600 文档 | PASS |
| 3 | 新建文档尺寸为 800×600（`UnitValue(px)`，不受标尺单位影响） | PASS |
| 4 | 预览按「最大序号 + 1」：目录已有 `-05`、大小写变体 `-09.PNG` → 下一个 `-10` | PASS |
| 5 | 预览的 `existingCount` = 2（大小写变体也算） | PASS |
| 6 | 第一次导出得到 `-10` | PASS |
| 7 | 第二次导出得到 `-11` | PASS |
| 8–9 | 两个 PNG 实际存在且非空 | PASS |
| 10 | 预置的 `-05` 内容未被动过（仅用 max+1 接续，不覆盖） | PASS |
| 11 | 预置的 `-09.PNG` 未被覆盖 | PASS |
| 12 | `-01`~`-04` 的空洞没有被复用 | PASS |
| 13 | 源文档名称/尺寸/图层不变、保持未保存状态（`saveAs` 为 copy，不改源） | PASS |
| 14 | 导出后源文档重新成为活动文档 | PASS |
| 15 | 没有留下临时文档 | PASS |
| 16–18 | 16 位文档 → `converted: true` + 警告、导出 `-12`、源文档仍是 16 位且未保存 | PASS |
| 19 | 非法前缀（含 `:`）返回 `ILLEGAL_CHARS` | PASS |
| 20 | 非法位数返回 `BAD_DIGITS` | PASS |
| 21 | 目录不存在返回 `FOLDER_MISSING` | PASS |
| 22 | 没有打开文档时返回「请先打开一个 Photoshop 文档」 | PASS |
| 23 | 导出的文件是 PNG（签名 `89 50 4E 47 0D 0A 1A 0A`，IHDR 800×600） | PASS |
| 24 | PNG 保留 alpha（颜色类型 6，RGBA） | PASS |

验收脚本的输入目录在 `.tmp\ps-verify\export`，每次都重新铺种子文件（`-05`、
`qpe-测试-09.PNG`、`-20` 目录、`-3 (1).png`、`-abc.png`），不会碰输出目录以外的文件。

> 透明说明：上表是**修复中文文件名问题之后**的完整运行（24/24）。此后做了一次等价
> 重构——把 `decodePercentName` 从宿主层移进 `matchSequence`，让 preview/export 共用
> 同一处解码。重构后的真实 Photoshop 复跑因本机用户当时正打开并编辑一个 PSD 文档，
> 被上面的安全保护跳过（不是失败）；该路径由 49 项 Node 测试覆盖，包含对
> `QPE-%E6%B5%8B%E8%AF%95-05.png` 的解码匹配断言。关闭 Photoshop 里的文档后，
> 直接重跑验收脚本即可复核。

### 2.1 默认前缀取自文档名（真实运行验证）

实现后追加了一次**只读**真实调用（不创建、不保存、不关闭任何文档）：用 COM 连接
当时正在运行的 Photoshop，`$.evalFile("jsx/host.jsx")` 后调用 `QPE_call("status", "{}")`。
对象是用户当时打开的 `2610-10-狼场景.psd`（3668×6000、RGB、8 位、22 图层、未保存）：

```json
{"hasDocument":true,"name":"2610-10-\u72FC\u573A\u666F.psd", ..., "suggestedPrefix":"2610-10-\u72FC\u573A\u666F","suggestedAdjusted":false,"ok":true}
```

- 宿主返回的 `suggestedPrefix` = `2610-10-狼场景`（去掉 `.psd`，保留中文与连字符）；
- `suggestedAdjusted` = `false`（文档名本身合法，没有发生清洗）；
- 文档没有被保存、关闭或修改（脚本只读 `status`）。

「手动改过前缀后不被覆盖」「切换文档按新文档名重填」属于面板端状态逻辑，由代码路径
保证，需在真实 CEP 面板里人工确认（见第 5 节第 1、2 条）。

### 安全保护

`verify-photoshop.ps1` 在开始前会先关掉**它自己**上次留下的 `QPE-Test` 等临时文档；
如果 Photoshop 里仍有其他文档打开，脚本会打印：

```
SKIP: Photoshop already has N other document(s) open.
Close them and rerun this script so your work is never touched.
```

并以非 0 退出，**不会**创建、导出或关闭任何用户文档。开发过程中因为用户正在编辑
`2610-10-狼场景.psd`，最后一次复跑就触发了该保护并主动跳过——这不是失败，是设计如此。

## 3. 验收中发现并修复的问题

1. **中文文件名匹配不到**（真实缺陷）：ExtendScript 的 `File.name` 把非 ASCII 字符
   做 UTF-8 百分号编码（`QPE-测试-05.png` → `QPE-%E6%B5%8B%E8%AF%95-05.png`）。
   已在 `jsx/core.jsx` 增加 `decodePercentName` 并在 `matchSequence` 内解码，补了单测。
2. **`documents.add` 尺寸随标尺单位变化**（测试脚本问题）：显式用 `UnitValue(800, "px")`。
3. **验收脚本中文乱码**（脚本问题）：Windows PowerShell 5.1 把无 BOM 的 UTF-8 `.ps1`
   按 ANSI 读，中文变乱码。脚本改成纯 ASCII，中文用 `[char]0xXXXX` 构造，
   ExtendScript 里用 `\uXXXX` 转义。

## 4. 未验证 / 需要人工确认

- **面板在真实 CEP 里的点击流程**：需要「安装 → 完全退出并重开 Photoshop → 窗口 →
  扩展功能 → 快速 PNG 导出」，然后手动选目录、点一次导出。自动化验收验证的是
  面板背后的宿主逻辑（与面板调用同一个 `QPE_call`），不是 CEP 渲染和按钮点击。
- **Photopea / 其他宿主**：不支持，未测。
- **macOS**：面板代码跨平台，但安装脚本是 PowerShell，未测。
- **Photoshop 2020+**：清单按 CEP 9 编写，理论上更老清单被新版本接受，未实测。

## 5. 手动验收清单（建议在安装后逐条点一次）

1. 打开任意文档 → 前缀应自动变为文档名（去掉 `.psd` 等扩展名）；文档名含 `:`、`/` 等
   字符时，下方出现「已按文档名自动填入，并去掉了文件名不允许的字符」提示；
2. 手动改前缀后等几秒 → 不被自动覆盖；切换到另一条文档 → 按新文档名重新填入；
3. 面板应显示文档尺寸；不选目录时「下一个文件」显示假设的 `前缀-01.png`；
4. 选一个空目录 → 点导出 → 文件出现、状态区显示完整路径、「打开目录」可用；
5. 再点一次 → 序号 +1；把中间某个序号文件删掉再导出 → **不复用空洞**；
6. 改成 1 位 / 3 位 → 序号宽度变化但计数不重置；
7. 输入含 `:` 的前缀 → 明确报错并列出字符，不静默修改；
8. 关闭所有文档再点导出 → 提示「请先打开一个 Photoshop 文档」；
9. 换一个前缀（手动输入）→ 序号从 01 重新开始，原前缀的文件不受影响。
