# Photoshop PNG Smart Export

Photoshop PNG 导出面板，按 `前缀-编号.png` 保存当前文档。导出时读取目标文件夹中的已有编号，接续保存，避免覆盖同名文件。

支持透明背景、中文前缀和编号位数设置，并记住输出目录与上次使用的前缀。

## 安装

Windows 安装包：[下载最新版本](https://github.com/FleatherYu/photoshop-png-smart-export/releases/latest)。

1. 下载并解压 `photoshop-png-smart-export-v版本号.zip`。
2. 运行解压目录中的 `install.cmd`，等待窗口显示 `Done.`。
3. 完全退出并重新启动 Photoshop。
4. 从「窗口 → 扩展功能 → PNG Smart Export」打开面板。

安装脚本将面板复制到以下用户目录，并启用加载未签名 CEP 面板所需的 `PlayerDebugMode`：

```text
%APPDATA%\Adobe\CEP\extensions\com.fleatheryu.pngsmartexport
```

面板基于 Photoshop CC 2019（20.0）/ CEP 9 开发。Photoshop 2020 及更新版本尚未实测，不保证兼容。

## 使用

打开 Photoshop 文档，在面板中设置前缀、编号位数和输出文件夹，点击「快速导出 PNG」。导出后会显示文件完整路径，点击「打开目录」可查看。

前缀默认使用文档名。切换文档时会自动更新；手动修改后，在同一文档中保留该设置。输出文件夹会被记住，无需每次重新选择。

## 文件命名

文件名格式为 `前缀-编号.png`。例如，前缀为 `261028-123`、编号位数为 2 时，依次导出为：

```text
261028-123-01.png
261028-123-02.png
261028-123-03.png
```

- 编号从目标文件夹中相同前缀的最大编号继续，不补空缺。例如已有 `-01` 和 `-03`，下一张为 `-04`。
- 编号位数仅控制补零，不限制编号长度。设置为 2 位时，第 100 张仍为 `-100.png`。
- 不同前缀分别计数。只有完整匹配 `前缀-数字.png` 的文件参与编号，`前缀-1 (1).png`、`前缀-abc.png` 等文件不计入。

## 色彩模式与位深

导出 CMYK、灰度、Lab 或 16/32 位文档时，面板会创建临时副本，转换为 8 位 RGB 后保存，不修改原文档。转换可能产生色差，面板会显示提示。

## 故障排查

### 扩展菜单中没有面板

确认已完全退出并重启 Photoshop，检查安装目录是否存在。Photoshop 2020 及更新版本尚未实测，可能存在兼容问题。

### 安装脚本无法运行或窗口一闪而过

确认已解压安装包，不要直接从压缩包内运行脚本。如果文件被 Windows 阻止，可在确认来源可信后，右键 ZIP →「属性」，检查是否有「解除锁定」选项，解除后重新解压。

如需查看错误信息，可从命令提示符中运行 `install.cmd`。

### 导出失败

检查是否已打开 Photoshop 文档、是否已选择输出文件夹，并查看面板中的具体错误提示。

## 卸载

运行安装包中的 `uninstall.cmd`，然后重启 Photoshop。卸载脚本只删除面板文件，不清除 Photoshop 的其他设置。

## 开发

界面使用 HTML/CSS/JS，Photoshop 端使用 ExtendScript。

`jsx/host.jsx` 由 `jsx/core.jsx` 和 `jsx/host-body.jsx` 生成：

```sh
node scripts/build-host.mjs
```

运行测试（使用 Node 内建测试，无需 `npm install`）：

```sh
node --test --test-isolation=none "tests/*.test.mjs"
```

通过 COM 调用 Photoshop 进行验收：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-photoshop.ps1
```

- 验收记录：[`docs/acceptance.md`](docs/acceptance.md)
- 设计说明：[`docs/design.md`](docs/design.md)
- `install.cmd` / `uninstall.cmd` 分别调用 `scripts\install.ps1` / `scripts\uninstall.ps1`。

## 限制

- 仅导出当前文档的整张画面，不支持按图层或组批量导出。
- 输出目录必须已存在，面板不会自动创建文件夹。
- 安装脚本仅支持 Windows；macOS 尚未实测，也未提供安装脚本。

## 后续计划

- **支持更多 Photoshop 版本**：目前只在 Photoshop CC 2019（20.0，CEP 9）上开发并实测；
  后续会在 Photoshop 2020 及更新版本上逐一验证，修正清单版本、`PlayerDebugMode`
  位置等兼容性问题。
- **图层 / 组批量快捷导出**：在现有「整张画面导出一张」之外，计划支持选中图层或图层组后，
  按同一套 `前缀-编号.png` 规则批量导出多张 PNG。

这两项都已在仓库的 Issues 里建了跟踪条目，完成后会随新版本发布。
