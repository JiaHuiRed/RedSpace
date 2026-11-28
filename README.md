# ⚡ RedSpace

简体中文 · [English](README.en.md)

[![版本](https://badgen.net/badge/版本/0.20.9/blue)](CHANGELOG.md)
[![平台](https://badgen.net/badge/平台/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://badgen.net/badge/TypeScript/7.x/3178c6)](https://typescriptlang.org)
[![Bun](https://badgen.net/badge/Bun/1.3.x/fb6e19)](https://bun.sh)
[![许可证](https://badgen.net/badge/许可证/MIT/grey)](LICENSE)

RedSpace 是一个 AI 工作区，在终端和桌面都能用。你可以接入自己的模型服务，也可以连接本地模型。

- **Code**：在项目里让 AI 解释代码、修改文件或运行测试。你可以设置哪些操作需要先确认，也可以在桌面工作台查看具体改动。
- **Chat**：和有自己性格的 AI 伙伴交谈。它可以记住你在以往对话里提过的偏好，也能按需调用工具。

## 🚀 安装与启动

以下步骤适用于 Windows 10/11，其他平台未经测试。请先安装 Git、Node.js 24 和 Bun 1.3.14。

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

装好依赖后，在仓库根目录任选一个入口：

| 界面        | 启动命令              |
| ----------- | --------------------- |
| 终端（TUI） | `bun dev`             |
| 桌面（GUI） | `bun run dev:desktop` |

首次对话前，按手册[添加 AI 模型](MANUAL.md#21-添加-ai-模型)。RedSpace 不附带模型服务额度。如果用 API 密钥，把它放在本机的 `~/.redcode/redcode.local.jsonc`，不要提交到 Git。

<p align="center">
  <img src="docs/assets/screenshot.png" width="760" alt="桌面工作台的文件树、输入区与上下文看板">
</p>

更多用法见[用户手册](MANUAL.md)，各版本的变化见[更新日志](CHANGELOG.md)。

## 许可

本项目采用 [MIT 许可证](LICENSE)。

## 💙 致谢

RedSpace 源自 RedCode，保留了 [OpenCode](https://github.com/anomalyco/opencode) 的代码、版权声明和贡献记录。感谢两个项目的贡献者。

<p align="center">
  <img src="docs/assets/chi-portrait.webp" height="180" alt="项目看板娘「赤」">
</p>
