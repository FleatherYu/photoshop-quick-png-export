# 快速 PNG 导出（Photoshop CEP 面板）

一个给 **Adobe Photoshop CC 2019（及更新版本）** 用的 CEP 面板：把当前文档按
`前缀-序号.png` 的规则导出到指定文件夹，序号自动接续，绝不覆盖已有文件。

- 目标版本：Photoshop CC 2019（20.0，CEP 9）；更新的 Photoshop 也兼容（见「兼容性」）。
- 平台：Windows（安装脚本是 PowerShell；面板本身跨平台，但未在 macOS 实测）。
- 依赖：无。测试用 Node 内建 `node:test`，不需要 `npm install`。

## 目录结构

```
photoshop-quick-png-export/
├─ CSXS/manifest.xml        CEP 清单（面板类型、菜单名、脚本入口）
├─ .debug                   调试端口配置（CEP 开发用）
├─ index.html               面板界面
├─ css/style.css            面板样式（深/浅两套主题变量）
├─ js/cep-bridge.js         面板 ↔ ExtendScript 的唯一通道
├─ js/panel.js              面板交互逻辑
├─ jsx/core.jsx             文件命名/序号纯逻辑（ES3，可单测）
├─ jsx/host-body.jsx        Photoshop DOM 操作（导出、选目录）
├─ jsx/host.jsx             生成物：core.jsx + host-body.jsx 拼接而成
├─ scripts/build-host.mjs   生成 host.jsx（--check 校验是否最新）
├─ install.cmd              双击安装
├─ uninstall.cmd            双击卸载
├─ scripts/install.ps1      安装到 CEP 扩展目录
├─ scripts/uninstall.ps1    卸载
├─ scripts/verify-photoshop.ps1  真实 Photoshop 验收（COM 驱动，24 项检查）
├─ tests/                   node:test 测试（52 项）
└─ docs/                    设计说明与人工验收记录
```

`jsx/host.jsx` 是生成文件，**不要直接改**；改 `core.jsx` 或 `host-body.jsx` 后运行：

```powershell
node scripts/build-host.mjs
```

## 安装（3 步）

1. 双击项目文件夹里的 **`install.cmd`**。
   - 从 GitHub 下载的 ZIP 要先右键 ZIP → 属性 → 勾选「解除锁定」，再解压，否则 Windows 可能会拦截脚本。
   - 脚本会自动重新生成宿主脚本、把面板复制到
     `%APPDATA%\Adobe\CEP\extensions\com.fleatheryu.quickpngexport`，并打开未签名面板所需的
     `PlayerDebugMode`。
2. **完全退出并重新打开 Photoshop**（扩展菜单在启动时读取）。
3. 菜单 **窗口 → 扩展功能 → 快速 PNG 导出** 打开面板。

以后修改了面板文件，重新双击 `install.cmd` 再重启 Photoshop 即可。

**卸载**：双击 **`uninstall.cmd`**（只删面板文件，不动注册表；面板随后从菜单里消失）。

> 命令行用法与双击等价：
> `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`、
> `powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1`。

## 使用

1. **前缀**：必填，例如 `261028-123`。首尾空格会被去掉；允许字母、数字、`_`、`-`、
   中文、内部空格和内部句点。Windows 不允许的 `\ / : * ? " < > |` 会被明确拒绝
   （提示里会列出是哪些字符），不会被静默替换。
   **默认会自动填入当前文档名**（去掉 `.psd` 等扩展名，例如 `2610-10-狼场景.psd`
   → `2610-10-狼场景`）。文档名里如果有 Windows 不允许的字符，会自动去掉并在
   输入框下方提示；手动改过前缀后，同一条文档里不会再被覆盖，切换到另一条文档
   时会按新文档名重新填入。
2. **位数**：1 / 2 / 3，默认 2。位数只决定补零的最小宽度：
   - 2 位时第 1 张是 `前缀-01.png`，第 100 张仍是 `前缀-100.png`（不截断）。
   - 切换位数**不会**重置序号。
3. **输出目录**：点「选择文件夹…」选目录；完整路径显示在下方（点击可复制）。
   不会自动创建隐藏目录，也不会默认往桌面/文档里写。
4. 面板会实时显示「导出名称」（这次将要写出的文件名，例：`261028-123-03.png`）。
5. 点 **快速导出 PNG**（或在输入框按 Enter / 按 Ctrl+Enter）。
   成功后状态区显示完整输出路径，并可「打开目录」或「复制路径」。

### 文件名与序号规则

- 文件名严格为 `前缀-序号.png`，序号 = 目录里**同前缀** PNG 的最大序号 + 1。
- 只认严格匹配 `^前缀-数字\.png$` 的文件（扩展名不区分大小写，前缀按字面匹配，
  前缀里的 `.`、`+`、`(` 等不会被当成正则语法）。
- 不递归子目录，不把同名文件夹当成 PNG，不把 `前缀-01.pngx`、`前缀-1 (1).png`
  之类近似名字算进去。
- 不复用空洞：目录里已有 `-01`、`-03` 时，下一张是 `-04`。
- 不同前缀互相独立；位数切换不影响已有计数，切换文档时前缀按新文档名重新填入
  （手动改过则不会在同一条文档里被覆盖）。
- **默认禁止覆盖**：写入前会重新扫描目录；目标文件已存在时自动换下一个序号，
  外部程序在扫描后抢先创建同名文件也会被二次检查拦住，失败时不会显示成功。

### 特殊颜色模式

CMYK、灰度、Lab、16/32 位文档也能导出：面板会先复制一份临时副本，把副本转成
8 位 RGB 再存 PNG，**源文档不会被修改**。状态区会提示颜色可能偏移、透明度行为
与源文档不同（例如 CMYK 无透明通道）。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| Photoshop CC 2019 (20.0) | 目标版本，CEP 9，清单按此版本编写 |
| Photoshop 2020+ | 使用更新的 CEP，一般可直接加载；**未实测**。若面板不出现，检查对应 `CSXS.10`/`CSXS.11` 的 `PlayerDebugMode` |
| Photoshop CS6 / CC 2018 | 不支持（面板用了 CEP 9 清单） |
| macOS | 面板代码跨平台，但安装脚本是 Windows 专用，**未实测** |
| 未签名面板 | 依赖 `PlayerDebugMode=1`；分发给他人的正式版应签名 |

## 测试

```powershell
node --test --test-isolation=none "tests/*.test.mjs"
```

- `node --test` 默认给每个测试文件起子进程，在受限沙箱里会 `spawn EPERM`，
  所以加了 `--test-isolation=none`（在同一个进程内跑）。
- 52 项测试覆盖：前缀校验、默认前缀取自文档名（去扩展名、清洗非法字符）、补零/不截断、
  正则转义、大小写、取最大值+1、不复用空洞、不同前缀独立、中文文件名的百分号编码解码、
  ASCII-only JSON、`host.jsx` 与源码一致性、清单结构、面板 DOM id/脚本/样式一致性，
  以及面板状态机（手动输入前缀后，5 秒文档轮询不会把前缀改回默认值）。

Photoshop 里的真实导出流程用 COM 验收（需要本机装有 Photoshop，且**关掉其他文档**；
脚本检测到有用户文档时会打印 `SKIP` 并以非 0 退出，绝不碰你的工作）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-photoshop.ps1
```

24 项检查的逐条结果见 [docs/acceptance.md](docs/acceptance.md)。

## 已知限制（本期不做）

- 只导出**当前活动文档**；批量处理所有已打开文档、图层/组批量导出、其他格式、
  前缀历史列表属于需求文档第 8 节的扩展，本期未实现。
- 序号只按 `-数字` 后缀接续；如果目录里已有别的工具生成的不带序号文件，不受影响。
- 面板不会替你创建输出目录；目录被删除或改名后需要重新选择。

## 文档

- [docs/design.md](docs/design.md)：架构、数据流、错误码、安全设计
- [docs/acceptance.md](docs/acceptance.md)：需求逐条验收记录（含未实测项标注）
