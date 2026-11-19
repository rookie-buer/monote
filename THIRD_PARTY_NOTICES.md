# 第三方组件 / Third-party components

MoNote 自身代码为 MIT。`web/vendor/` 下的两个库按各自许可证分发，完整文本见同目录 `LICENSE`。

| 组件 | 版本 | 许可证 | 用途 | 完整文本 |
|---|---|---|---|---|
| [KaTeX](https://katex.org/) | 0.16.4 | MIT © 2013-2020 Khan Academy and other contributors | 数学公式排版 | `web/vendor/katex/LICENSE` |
| [highlight.js](https://highlightjs.org/) | 11.9.0 | BSD 3-Clause © 2006 Ivan Sagalaev | 代码块语法高亮 | `web/vendor/hljs/LICENSE` |

两者均为纯静态资源（一个 js + 一个 css + 字体/语言包），直接内嵌以保证应用**离线可用、无 npm 依赖**。

除此之外：

- 应用图标由 `tools/makeicon.swift` 现场绘制，无外部素材。
- 字体全部走系统栈（SF / PingFang SC / Menlo 等），不内嵌字体文件。
- 交互方式参考了 Typora 的「即时渲染」思路，但**本仓库不含其任何代码、资源或字体**。
