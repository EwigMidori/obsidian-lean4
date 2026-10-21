# Lean4

[![CI](https://github.com/pluveto/obsidian-lean4/actions/workflows/ci.yml/badge.svg)](https://github.com/pluveto/obsidian-lean4/actions/workflows/ci.yml) · [MIT License](LICENSE)

Lean 4 proof blocks for Obsidian: independent examples, opt-in shared sessions, proof goals, and English / Simplified Chinese UI. Desktop only.

采用 [MIT 许可证](LICENSE)。欢迎提交 Issue 和 PR，开发约定见 [贡献指南](CONTRIBUTING.md)，版本变化见 [变更日志](CHANGELOG.md)。正式发布后可从 [Releases](https://github.com/pluveto/obsidian-lean4/releases) 下载三个插件文件，按下文说明手动安装。目前尚未上架 Obsidian 社区插件目录。

在 Obsidian 笔记中编辑、检查 Lean 4 代码块，并查看光标位置的证明目标。
**默认每块独立**；只有显式添加相同 `session` 的块，才在本篇笔记内按顺序共享上下文。

这是面向 Obsidian **桌面版**的插件。**普通笔记无需创建 Lean 项目，也无需填写项目路径。**
默认基础环境由插件管理：检测本机已有的 Lean；缺少时，通过 **Prepare Lean** 一次准备。
只有需要 Mathlib、自定义依赖或其他 Lean 版本时，才使用高级项目模式。

## 已实现功能

- `lean` / `lean4` 默认独立检查，`check=off` 仅展示，`title` 为块添加标题。
- `session` 按需连接一段连贯的定义与证明，未指定时保持独立。
- 默认管理基础 Lean / Std 环境，提供显式准备、进度、取消和重试。
- 编辑时显示检查状态、错误标记和基础语法着色；光标进入块后按需检查。
- 侧栏显示光标处的证明目标、局部假设和诊断；点击诊断跳转到笔记中的位置。
- 阅读模式显示代码、当前会话保存的结果，以及 **Check block** / **Check session** 按钮。
- 实时预览中，检查图标与 Obsidian 的源码图标并排；普通阅读模式保留工具栏检查图标。
- 消息区分错误、警告与信息，证明目标分别展示已知条件和待证明内容。
- 界面跟随 Obsidian 的语言，支持简体中文和英文；Lean 代码、证明目标和编译器消息保持原文。
- 常用 Unicode 输入：在 Lean 块内输入 `\alpha`、`\forall`、`\to` 等后按 Tab；
  未识别的序列保留编辑器原有 Tab 行为。Enter 保持缩进，并在常见证明开头增加缩进。
- 活动块优先检查、全篇检查队列、服务状态和手动重启。

首版使用纯文本目标；LSP 补全、悬停类型、跳转定义和交互式 Lean widgets 尚未实现。
目前整个插件共享所选的一个环境；基础环境与高级项目环境二选一。

## 构建与安装

构建和测试需要 Node.js 20.19+（20.x）、22.12+（22.x）或 24+。在本目录执行：

```sh
npm ci
npm run check
```

`check` 包含类型检查、自动化测试、架构检查和发布构建；单独构建可运行 `npm run build`。
将以下三个文件复制到你的 Vault 中：

```text
<Vault>/.obsidian/plugins/lean4-blocks/
  main.js
  manifest.json
  styles.css
```

随后在 Obsidian 的社区插件设置中启用 **Lean4**。
最低 Obsidian 版本为 1.8.0。这个仓库没有自动向 Vault 安装插件的步骤。

开发时运行 `npm run dev`，源文件变化会重新构建 `main.js`。在 Obsidian 中重新加载插件，
才能应用新的构建。

## 第一次使用：直接写在笔记中

启用插件后，保留默认的 **Basic (managed automatically)** 模式，在普通笔记写：

````markdown
```lean title="第一个证明"
example (n : Nat) : n = n := by
  rfl
```
````

把光标移到 `rfl` 行，或执行 **Check current block**。插件先检测本机是否已有
基础环境使用的 Lean 4.35.0；如果已有，就自动使用，不需要打开设置。

如果显示尚未安装，插件会打开目标侧栏；点击其中的 **Prepare Lean** 即可。
阅读视图和插件设置中也提供同一操作，
也可以执行命令 **Prepare basic Lean environment**。插件会显示准备状态；
可用 **Cancel preparation** 取消，失败后用 **Retry preparation** 重试。
准备成功后会继续此前的检查或目标查询。

首次检测不会启动下载。只有主动准备时才安装缺少的工具：

- 已有 elan 时，安装指定的 Lean 4.35.0 工具链，不更改默认工具链。
- 没有 elan 时，下载固定版本的官方 elan 发行包并核对 SHA-256，再安装 Lean；
  elan 放在插件自己的用户缓存中，不修改系统或用户的 PATH。

基础环境包括 Lean 和 Std；例如可以在块内写 `import Std`。它不自动下载 Mathlib。
需要查看目标时，执行 **Show goals** 或点击左侧 σ 图标。

## 高级用法：Mathlib 或已有项目

在 **Settings → Lean4 → Lean environment** 选择
**Existing project (advanced)**，再填写已有 Lake 项目路径。先在该项目目录中确认：

```sh
lake env lean --version
lake build
```

项目应有 `lean-toolchain`，并有 `lakefile.lean` 或 `lakefile.toml`。
使用 Mathlib 的笔记块需要所选项目已经配置并构建 Mathlib；插件只复用该项目的环境。
Lean 版本由项目的 `lean-toolchain` 决定，不在笔记中单独配置。

如果 Obsidian 从桌面启动后找不到 `lake`，需要在插件设置中填写 Lake 可执行文件的绝对路径。
在 Windows 上通常是 `C:\Users\<用户名>\.elan\bin\lake.exe`，以你的实际安装位置为准。
可执行文件路径中可以包含空格，但不要在该设置里附加命令行参数。
插件在项目目录启动 `lake serve`，使用内存中的独立文档，不向项目写入笔记代码；
导入所需的构建产物需要提前准备好。Lake 仍可能维护自己的 `.lake` 元数据。
已通过 Lean 4.35.0 / Lake 5.0.0 的真实服务验证；其他版本尚未逐一测试。
升级前已经保存项目路径的用户会保留高级项目模式，不会自动切换到基础环境。

## 设置与操作

默认基础使用不需要修改设置。可在 **Settings → Lean4** 调整：

| 设置项 | 含义 | 默认值 |
| --- | --- | --- |
| Lean environment | 自动基础环境，或高级已有项目 | Basic (managed automatically) |
| Lake project directory | 仅高级模式：已有 Lake 项目的绝对路径 | 未配置 |
| Lake executable | 仅高级模式：`lake` 或其可执行文件绝对路径 | `lake` |
| Check delay | 编辑停止后的检查等待时间，50–2,000 ms | 200 ms |
| Maximum open documents | 同时保留的 Lean 文档上限，1–16；独立块或整个 session 各算一份 | 4 |
| Idle block timeout | 非活动文档的空闲回收时间，10–600 秒；共享 session 整体回收 | 60 秒 |

性能选项位于 **Performance** 折叠区。修改后点击 **Save and apply** 保存并重建服务会话；
下一次检查时启动服务。
在命令面板搜索 **Lean4**：

| 命令 | 作用 |
| --- | --- |
| Prepare basic Lean environment | 基础模式中检测和准备 Lean；缺少工具时才下载 |
| Check current block | 检查当前块；有 `session` 时检查所在整组，未改变的内容与上下文可复用结果 |
| Check all blocks in current note | 将本笔记尚未完成的独立块与共享 session 去重后送入有界队列 |
| Show goals | 打开证明目标侧栏，也可以点击左侧 σ 图标 |
| Restart language server | 重启服务并清除旧会话状态 |

先执行 **Show goals**，再把光标放入证明的 tactic 行；侧栏会显示该位置的目标。
编辑器中的错误标记悬停可见消息，侧栏的诊断消息可以点击定位。
工具栏的三角形图标用于检查，悬停可见操作名称；消息中的行列位置用于跳转，
消息正文仍可选择和复制。目标侧栏用“已知”和“待证明”区分假设与目标。
阅读视图的 **Checked** 状态来自本次会话中该版本代码及其共享上下文的结果，悬停状态可见缓存说明；
插件不把上次运行的检查结果持久化为下次启动时的证明。

语言自动读取 Obsidian 设置，无需另设插件语言。简体中文语言设置使用中文，
其他语言设置暂用英文；旧版本未提供语言查询 API 时也使用英文。
本文的英文命令名对应中文界面的“检查当前代码块”“检查当前笔记中的所有代码块”
和“显示证明目标”等名称。运行状态会翻译，Lean 的目标、诊断及后台原始错误详情保留原文。

## 默认独立代码块

````markdown
```lean
def answer : Nat := 42
example : answer = 42 := by
  rfl
```

```lean
def answer : Nat := 7
example : answer = 7 := by
  rfl
```
````

两个块都定义 `answer`，但不会互相覆盖或产生重名错误。要复用库中的定义，在需要的
每个块顶部写 `import`；不要依赖同一笔记中前面代码块的声明。

## 用 session 共享连贯的证明

当几段代码确实需要互相引用时，给它们相同的 `session`：

````markdown
```lean session=arithmetic title="定义"
import Std
def base : Nat := 40
```

这里仍然可以写普通说明文字。

```lean session=arithmetic title="证明"
example : base + 2 = 42 := by
  rfl
```
````

**共享由笔记当前内容和位置决定，不依赖点击历史。** 先检查第二块也能取得第一块的定义；
重新打开笔记不需要按顺序点击。移动、删除或修改前面的代码，会改变这一组后续代码的上下文。

规则如下：

- 同一篇笔记中，名称完全相同的 `session` 按出现顺序组成一个 Lean 文档。
- 不同 session、未写 session 的独立块、不同笔记中的同名 session 彼此隔离。
- `check=off` 和无效围栏属性的块完全排除，定义、导入和错误都不会进入 session。
- `import` 放在第一个参与块的顶部。后面的导入不会被自动移到前面，位置错误会报错；
  如果最前面的同名块是 `check=off`，它不算第一个参与块。
- 组内的错误可能影响后续证明；错误仍定位到原来的块。当前块没有自身错误，
  不代表整组无错误，界面会另外显示 session 的错误信息。

编辑状态、阅读标题和目标位置会显示 **Session: 名称**；带 `check=off` 的同名块显示
**Excluded from session: 名称**。阅读视图和侧栏的检查按钮显示 **Check session**，
检查的是当前整组。修改别的 session 不会改变这一组的 Lean 上下文。

`session` 名称区分大小写，按原值精确匹配，包括空格。含空格时使用引号，例如
`session="算术 推导"`。空名称、全空白名称或包含控制字符的名称属于无效属性。
不想共享时，直接省略 `session`。

完整例子见 [共享 session 示范](<examples/共享 session 示范.md>) 和
[跨笔记隔离示范](<examples/session 跨笔记隔离.md>)。

## 围栏属性与只展示示例

支持 `lean` 和 `lean4` 语言标记。对于不完整语法、错误示范或只想保留的代码，
添加 `check=off`，插件会将其标为 **Display only**（仅展示），不会检查它：

````markdown
```lean check=off title="函数语法示范"
example (P Q : Prop) : P → Q := by
  -- 只展示语法，不要求它构成完整证明。
```
````

| 围栏属性 | 行为 |
| --- | --- |
| `check=on` | 检查该块；`lean` / `lean4` 省略此属性时的默认行为 |
| `check=off` | 仅展示，不启动该块的 Lean 文档 |
| `title="自然数示例"` | 自定义展示标题，不改变 Lean 代码、命名空间或检查结果 |
| `session=arithmetic` | 与本篇笔记中同名的参与块按顺序共享上下文 |

属性之间用空白分隔，`=` 两侧不要加空白，属性名和值区分大小写。
`title` 和 `session` 可以不加引号，但含空格时需要使用双引号或单引号。
引号内支持 `\"`、`\'`、`\\`、`\n`、`\r` 和 `\t`；其他转义保留反斜线，
例如 `title="\alpha"` 会保留 `\alpha`。不加引号的值不处理转义。

未知属性、重复属性、无效 `check` 值、缺少 `=` 或未闭合引号都会显示围栏错误，
并将该块保持为仅展示。修正属性之后才按指定策略检查，不会默默忽略拼写错误。
只修改标题不会改变 Lean 文档版本；修改 `check` 或 `session` 会重新确定参与块和上下文。

旧标记 `lean-example` / `lean-off` 仍然兼容，始终用于仅展示。它们不能通过
`check=on` 改成可检查块；如需检查，请将语言标记改回 `lean` 或 `lean4`。

当前识别笔记顶层的反引号或波浪线围栏，允许 0–3 个空格缩进；支持 LF 和 CRLF。
列表或引用内部的嵌套围栏尚不支持。代码块中间的空白行属于该块；只有显式的 `session` 才连接多个块。
尚未输入关闭围栏时，文档末尾仍属于当前块，可以继续检查、输入 Unicode 和缩进；
已经关闭的围栏行本身交回 Markdown 编辑器处理。

完整示例见 [独立代码块示范](examples/独立代码块示范.md)。

基础高亮是轻量词法着色，不替代 Lean 的解析器。超过 200,000 个字符的单块会跳过
编辑器和阅读视图的着色，原文仍保留。检查超过 60 秒会标记超时并回收该文档；非常复杂的证明
可能触及这个首版限制。

## 基础环境放在哪里

基础项目位于用户缓存，不要求在 Vault 中创建项目文件：

| 平台 | 默认缓存根目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\lean4-obsidian-plugin` |
| macOS | `~/Library/Caches/lean4-obsidian-plugin` |
| Linux | `$XDG_CACHE_HOME/lean4-obsidian-plugin`，未设置时使用 `~/.cache/lean4-obsidian-plugin` |

缓存中的 `basic-v4.35.0` 由插件维护。若需要私有 elan，安装在缓存的 `elan` 子目录；
如果复用了已有 elan，新工具链会交给该 elan 管理。插件不更改默认工具链或持久化的 PATH，
也不在用户的已有项目中创建基础环境。

自动安装支持 Windows x64、macOS x64 / arm64、Linux x64 / arm64，使用系统 `tar`
解开经过校验的官方发行包。其他平台可以使用已安装的环境或高级项目模式。
目前实际运行验证的平台为 Windows x64；支持清单不代表所有平台都已实测。

## 开发与验证

```sh
npm run typecheck
npm test
npm run check:architecture
npm run bench
```

架构检查使用 TypeScript AST 检查生产代码中的顶层函数和反向依赖；
回调可以位于负责该行为的对象内部。它是结构约束，不替代对对象职责的人工审查。
各个对象的行为归属见 [架构说明](docs/architecture.md)。

本轮 UI 与语言改版通过类型检查、187 个默认测试、30 个生产文件的架构检查与发布构建。
5 个需要显式开关的真实 Lean / 安装器测试本轮跳过；此前的真实验证结果单独保留在验证记录中。
UI 自动化运行在 CodeMirror + jsdom 和 Obsidian API 测试替身上，
**尚未完成真实 Obsidian 桌面验收**。

完整 Lean 大工具链的重新下载没有在本轮重跑；具体测试范围、各轮实际结果与
复现命令见验证记录。

性能基准只测插件自身的笔记解析与状态协调，不把 Lean 编译、Mathlib 导入、
CodeMirror 布局或 Obsidian 窗口绘制混入同一数字。测试说明与实测结果见
[验证记录](docs/validation.md) 和 [性能记录](docs/performance.md)。
