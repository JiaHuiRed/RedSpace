# ⚡ RedSpace

[简体中文](README.md) · English

[![Version](https://badgen.net/badge/Version/0.20.7/blue)](CHANGELOG.md)
[![Platform](https://badgen.net/badge/Platform/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://badgen.net/badge/TypeScript/7.x/3178c6)](https://typescriptlang.org)
[![Bun](https://badgen.net/badge/Bun/1.3.x/fb6e19)](https://bun.sh)
[![License](https://badgen.net/badge/License/MIT/grey)](LICENSE)

RedSpace is an AI workspace for the terminal and desktop. You can connect it to a model provider of your choice or use a local model.

- **Code**: Ask the AI to explain code, edit files, or run tests in your project. You choose which actions need approval and can review the changes in the desktop app.
- **Chat**: Talk with an AI companion that has its own personality and memory. It can remember your preferences across conversations and use tools when you need a hand.

## 🚀 Install and run

We test on Windows 10 and 11 only. For the source setup below, install Git, Node.js 24, and Bun 1.3.14.

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
```

From the repository root, run the command for the interface you want:

| Interface      | Command               |
| -------------- | --------------------- |
| Terminal (TUI) | `bun dev`             |
| Desktop (GUI)  | `bun run dev:desktop` |

Before your first conversation, [configure a model](MANUAL.md#21-添加-ai-模型) (instructions in Chinese). RedSpace does not include model credits. If you use an API key, keep it in `~/.redcode/redcode.local.jsonc` on your machine and out of Git.

<p align="center">
  <img src="docs/assets/screenshot.png" width="760" alt="Desktop workspace with the file tree, message input, and context dashboard">
</p>

See the [user manual](MANUAL.md) for more ways to use RedSpace, or the [changelog](CHANGELOG.md) for release notes. Both are in Chinese.

## License

RedSpace uses the [MIT License](LICENSE).

## 💙 Acknowledgments

RedSpace grew out of RedCode and retains code, copyright notices, and commit history from [OpenCode](https://github.com/anomalyco/opencode). Thank you to the contributors to both projects.

<p align="center">
  <img src="docs/assets/chi-portrait.webp" height="180" alt="Chi, the project mascot">
</p>
