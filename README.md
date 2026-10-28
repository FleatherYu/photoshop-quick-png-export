# Photoshop PNG Smart Export

给 Photoshop 用的一个小面板：把当前画面导出成 PNG，文件名自动带「前缀 + 编号」，
编号自动往后排，**永远不会覆盖已有文件**。

这份说明写给只用 Photoshop 画画、不写代码的人，照着做就行。

## 它帮你做什么

举个例子：你今天画了一组图，想按 `261028-123-01.png`、`261028-123-02.png`… 这样存。

- 不用手动改名，面板会自己数到第几张；
- 不会覆盖：目录里已经有 `-01`、`-02`，它会存成 `-03`；
- 透明背景会保留；
- 支持中文前缀，比如 `立绘-小雨`；
- 文件存在哪个文件夹、上次用的前缀，下次打开面板还会记得。

## 安装（Windows，Photoshop 2019 及更新版本）

### 第 1 步：下载

打开下载页：

**https://github.com/FleatherYu/photoshop-png-smart-export/releases/latest**

在页面下方「Assets」里下载 `photoshop-png-smart-export-v1.0.1.zip`（版本号可能更新，下最新的即可）。

### 第 2 步：解压

把 ZIP 解压到任意文件夹（桌面也行）。

- 不要在压缩包预览里直接双击里面的文件，要先解压；
- 如果是从浏览器下载的 ZIP，先右键这个 ZIP → 属性 → 勾选「解除锁定」→ 确定，
  再解压。否则 Windows 可能会拦住里面的安装脚本。

### 第 3 步：安装

双击解压出来的 **`install.cmd`**。

- 会出现一个黑色窗口，最后显示 `Done.` 就说明装好了，按任意键关闭；
- 如果弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」；
- 安装脚本只做两件事：把面板复制到你的用户目录
  `%APPDATA%\Adobe\CEP\extensions\com.fleatheryu.pngsmartexport`，
  以及打开 Photoshop 加载未签名面板所需的 `PlayerDebugMode` 开关。不会改别的系统设置。

### 第 4 步：重启 Photoshop

**完全退出** Photoshop（关掉所有 PS 窗口，不是只关文档），再重新打开。
扩展菜单是在启动时读取的，不重启看不到。

### 第 5 步：打开面板

菜单 **窗口 → 扩展功能 → PNG Smart Export**。

面板可以拖到右边当常驻面板，也可以关掉随时再从菜单打开。

## 怎么用（日常就 4 步）

1. 在 Photoshop 里打开要导出的图；
2. 看面板里的「前缀」——默认已经填好这张图的名字，可以直接用，也可以改
   （比如加上日期 `261028-`）；
3. 点「选择文件夹…」选好保存位置（只需选一次，之后会记住）；
4. 点 **快速导出 PNG**。

导出成功后，面板上会显示完整路径，可以点「打开目录」直接看到文件。

下次再导出同一个前缀，编号会自动 +1，不用管。

## 编号规则（简单版）

文件名固定是 **`前缀-编号.png`**：

- 前缀 `261028-123`、位数选 2 → `261028-123-01.png`、`261028-123-02.png`…
- 位数只决定补几个零：选 2 位，到第 100 张是 `-100.png`（不会变成 `-00`）；
  选 1 位就是 `-1.png`；选 3 位就是 `-001.png`；
- 文件夹里已经有 `-01`、`-03`，下一张是 `-04`（不会回头填 `-02`）；
- 不同前缀各数各的，互不影响；
- 只认 `前缀-数字.png` 这种完整名字，`前缀-1 (1).png`、`前缀-abc.png` 不会被算进去；
- 换一个文档，前缀会自动换成新文档的名字；如果你手动改过前缀，同一条文档里不会再被自动改掉。

## 特殊文件也能导出（CMYK / 16 位）

CMYK、灰度、Lab、16 位、32 位的文档也能存 PNG：面板会复制一份临时副本，
把副本转成普通的 8 位 RGB 再保存，**你的原图不会被改动**。
颜色可能和屏幕上略有差别，面板会提示。

## 常见问题

**菜单里找不到 PNG Smart Export？**
- 确认 Photoshop 是**完全退出后重新打开**的；
- 检查这个文件夹是否存在：
  `%APPDATA%\Adobe\CEP\extensions\com.fleatheryu.pngsmartexport`
- 如果用的是 Photoshop 2020 或更新版本，个别版本需要额外设置，截图告诉我，我帮你看。

**双击 install.cmd 一闪而过？**
- 先确认已经解压，不是直接在压缩包里运行；
- 也可以右键 `install.cmd` →「以管理员身份运行」试试；
- 还不行就把黑窗口里的文字截图发我。

**提示「Windows 已保护你的电脑」？**
点「更多信息」→「仍要运行」。这是 Windows 对从网上下载的脚本的常规提醒。

**点导出没反应 / 报错？**
- 先确认 Photoshop 里确实打开了文档；
- 面板会显示具体原因（比如「请先打开一个 Photoshop 文档」「请选择输出文件夹」）。

**能装在 Mac 上吗？**
面板本身可以跨平台，但安装脚本是 Windows 专用，目前没有 Mac 的一键安装方式。

## 卸载

双击解压文件夹里的 **`uninstall.cmd`**，然后重启 Photoshop，面板就会从菜单里消失。
（这个脚本只删除面板文件，不会清掉 Photoshop 的其它设置。）

## 给懂代码的人（可以跳过）

- Photoshop CEP 9 面板（CC 2019 / 20.0，更新版本一般也能加载）；界面是 HTML/CSS/JS，
  Photoshop 端是 ExtendScript（`jsx/host.jsx`，由 `jsx/core.jsx` + `jsx/host-body.jsx`
  生成：`node scripts/build-host.mjs`）。
- 测试（无需 `npm install`，用 Node 内建测试）：
  `node --test --test-isolation=none "tests/*.test.mjs"`（53 项）。
- 真实 Photoshop 验收：`powershell -ExecutionPolicy Bypass -File scripts\verify-photoshop.ps1`
  （COM 驱动，24 项，结果见 `docs/acceptance.md`）。
- 设计说明见 `docs/design.md`；安装脚本 `install.cmd` / `uninstall.cmd` 只是对
  `scripts\install.ps1` / `scripts\uninstall.ps1` 的包装。

## 已知限制

- 只导出**当前文档的整张画面**；按图层、按组批量导出暂不支持；
- 不替你创建输出文件夹（选一个已有的文件夹即可）；
- 序号只按 `前缀-数字.png` 接续，不会动目录里的其它文件；
- 未在 macOS 实测；Photoshop 2020+ 未实测（代码按兼容方式编写）。
