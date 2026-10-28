# Photoshop Quick PNG Export

Photoshop PNG 导出面板，按 `前缀-编号.png` 保存当前文档，或把当前选中的图层 / 图层组批量导出成多张 PNG。导出时读取目标文件夹中的已有编号，接续保存，避免覆盖同名文件。

支持透明背景、中文前缀和编号位数设置，并记住输出目录与上次使用的前缀。

## 界面

| 整张画面模式 | 选中图层模式 |
| --- | --- |
| <img src="docs/images/panel-document-mode.png" width="270" alt="整张画面模式：按前缀-编号导出当前文档"> | <img src="docs/images/panel-selection-mode.png" width="500" alt="选中图层模式：批量导出选中的图层/组"> |

## 安装

Windows 安装包：[下载最新版本](https://github.com/FleatherYu/photoshop-quick-png-export/releases/latest)。

1. 下载并解压 `photoshop-quick-png-export-v版本号.zip`。
2. 运行解压目录中的 `install.cmd`，等待窗口显示 `Done.`。
3. 完全退出并重新启动 Photoshop。
4. 从「窗口 → 扩展功能 → Photoshop Quick PNG Export」打开面板。

安装脚本将面板复制到以下用户目录，并启用加载未签名 CEP 面板所需的 `PlayerDebugMode`：

```text
%APPDATA%\Adobe\CEP\extensions\com.fleatheryu.pngsmartexport
```

面板基于 Photoshop CC 2019（20.0）/ CEP 9 开发。Photoshop 2020 及更新版本尚未实测，不保证兼容。

## 使用

打开 Photoshop 文档，在面板中设置前缀、编号位数和输出文件夹，点击「快速导出 PNG」。导出后会显示文件完整路径，点击「打开目录」可查看。

面板顶部可以切换导出模式：

- **整张画面**（默认）：导出当前文档的完整画面，一次一张；
- **选中图层**：先在 Photoshop 图层面板里选中若干图层 / 组，再点导出。每个选中对象单独导出一张，按图层面板的从上到下顺序编号，沿用同一套 `前缀-编号.png` 规则。导出前会在面板里列出将要导出的对象和预计文件名。

选中图层模式下的约定：

- 同时选中父组和它的子层时，只导出父组（子层不会重复导出）；
- 每张图只显示该对象，其他图层隐藏；组内原有的子层可见性、剪贴关系和内部效果保持不变；
- 明确选中的隐藏图层也会导出；
- 对象完全透明（如空图层、空组）时跳过，不占用编号；
- 与对象外部存在依赖关系（剪贴蒙版、调整图层、非正常混合模式、穿透组等）时，单独导出会失真，该对象会被跳过并在结果里说明原因；
- 某项导出失败时整批停止，已成功导出的文件保留；再次导出会从目录中的最大编号继续，不覆盖、不补空缺。

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
powershell -ExecutionPolicy Bypass -File scripts\verify-batch-photoshop.ps1
```

`verify-batch-photoshop.ps1` 会跑 `tests/photoshop/batch-acceptance.jsx`（真实多选、组内剪贴 / 隐藏子层、16 位转换、外部剪贴依赖、空文档、displayDialogs 恢复等），并检查导出的 PNG 像素。

- 验收记录：[`docs/acceptance.md`](docs/acceptance.md)
- 设计说明：[`docs/design.md`](docs/design.md)
- `install.cmd` / `uninstall.cmd` 分别调用 `scripts\install.ps1` / `scripts\uninstall.ps1`。

## 限制

- 图层批量导出只处理当前选中的图层 / 组，不提供「导出全部图层」或面板内勾选对象；首版没有逐项进度和取消，执行期间不能重复触发。
- 跨对象依赖（剪贴蒙版、调整图层、非正常混合、穿透组、祖先效果）不会被自动带入，相关对象会被跳过并在结果里说明。
- 输出目录必须已存在，面板不会自动创建文件夹。
- 安装脚本仅支持 Windows；macOS 尚未实测，也未提供安装脚本。

## 后续计划

- **支持更多 Photoshop 版本**：目前只在 Photoshop CC 2019（20.0，CEP 9）上开发并实测；
  后续会在 Photoshop 2020 及更新版本上逐一验证，修正清单版本、`PlayerDebugMode`
  位置等兼容性问题。
- **扩充依赖支持矩阵**：按真实样例逐步支持整组依赖、调整图层等场景，减少跳过。
- **逐项进度与取消**：批量较大时提供进度反馈和中断能力。
