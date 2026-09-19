# orb

一个轻量的网页增强悬浮球油猴脚本：**AI 对话 / 划词处理 / 批注 / 快速记录 / 翻译 / 搜索 / WebDAV 保存**，单文件 IIFE，零外部依赖，桌面与移动端（Via / 安卓浏览器）均可使用。

## 功能

- **悬浮球 + 子球**：主球常驻页面边缘，展开后按场景（全局 / 划词）显示对应子球。
- **AI 对话面板**：流式 Markdown 渲染、可切换服务与模型、提示词胶囊、附加网页正文 / 选中内容、继续对话。
- **划词面板**：选中文本后用预设提示词直接处理，处理完可继续追问。
- **批注 / 快速记录**：引用原文一键保存，支持 WebDAV / GitHub / Gitee。
- **翻译**：可接入任意 OpenAI 或 Claude 兼容格式的 AI 服务，按段落注入译文。
- **搜索**：自定义搜索引擎，`%s` 作为搜索词占位。
- **移动端适配**：视觉视口键盘避让、面板拖拽、点击外部收起。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/) / Via 浏览器。
2. 打开 [`orb.user.js`](https://github.com/enneaa/orb-userscript/raw/main/orb.user.js) 安装。
3. 在悬浮球长按或快捷键 `Alt+S` 打开设置，添加你的 AI 服务（OpenAI / Claude 兼容格式）。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+S` | 打开设置面板 |
| `Alt+C` | 打开 AI 对话 |
| `Alt+T` | 触发整页翻译 |
| `Esc` | 关闭当前面板 |

## 变量模板

提示词中支持以下变量，运行时自动替换：

- `{{content}}`：选中文本（无选中时为网页正文摘要）
- `{{selection}}`：选中文本
- `{{page}}` / `{{url}}` / `{{title}}`：网页正文、链接、标题

## 开发

单文件 IIFE，无构建步骤。修改后用任意油猴管理器加载即可。

## License

MIT
