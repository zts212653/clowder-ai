# 内置字体

| 素材 id | 字体 | 文件 | 来源 | 许可 |
|---|---|---|---|---|
| font.inter | Inter（可变：opsz, wght） | inter-var.woff2 | github.com/google/fonts ofl/inter | SIL OFL 1.1，见 OFL-Inter.txt |
| font.mono | JetBrains Mono（可变：wght） | jetbrains-mono-var.woff2 | github.com/google/fonts ofl/jetbrainsmono | SIL OFL 1.1，见 OFL-JetBrainsMono.txt |
| font.sc | Noto Sans SC（可变：wght） | noto-sans-sc-var.woff2 | github.com/google/fonts ofl/notosanssc | SIL OFL 1.1，见 OFL-NotoSansSC.txt |

- 子集：拉丁 / 符号 / 制表；中文取 GB2312 一级常用字（3755）加界面文案里用到的字。子集外的字按字体栈落到系统字体。
- `make.py` 把这些文件写成素材登记 `theme/default/assets/font-assets.js`（data: 内嵌），每次构建都带上，不依赖网络。
- 主题选“内置字体”（默认）时用它们；选“系统字体”时不用；加载失败时字体栈自动落到系统字体。
