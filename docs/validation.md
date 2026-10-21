# 验证范围

验证分为四个层次，结果应分别记录：

1. **纯逻辑和协议测试**：不依赖 Obsidian，验证代码块身份、显式 session 分组、位置映射、
   调度、过期结果处理、进程协议与资源释放。
2. **CodeMirror DOM 集成**：在 jsdom 中创建真实的 CodeMirror `EditorView`，
   验证按键和装饰更新；Obsidian API 使用测试替身，不等于运行了 Obsidian。
3. **真实 Lean 服务**：使用一个可用的 Lake 项目启动 Lean 服务，验证实际
   `initialize`、独立与共享文档检查、诊断与目标查询。需要本机已安装对应工具链。
4. **Obsidian 桌面验收**：安装构建后的三个插件文件，使用实际编辑器和阅读视图。
   自动化单元测试和成功构建都不能代替这一步。

## UI 与语言改版本轮结果

2026-10-21，Windows x64 / Node.js v25.9.0，未设置真实服务或安装器开关，
运行完整 `npm run check`，退出码为 0：

| 项目 | 实际结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| Vitest | 17 个文件通过、4 个文件跳过；187 个测试通过、5 个跳过，共 192 个 |
| UI 与语言自动化 | 8 个文件、61 个测试通过 |
| 架构 AST 检查 | 30 个生产 TypeScript 文件通过 |
| 发布构建 | 通过，生成 `main.js` |
| 真实 Lean / 安装器 | 本轮未启用；此前结果见下一节 |

新增验证覆盖中英词典、语言选择与旧 API 回退、图标的可访问名称和禁用行为、
宿主稍后添加操作栏时检查按钮与源码按钮并排、普通阅读模式回退、观察器释放，
以及诊断正文和证明目标保持原文。

另以真实 `LeanReadingBlock`、`LeanGoalView` 和展示对象生成浏览器预览，只替换 Obsidian
公共 API 与工作区数据。预览加载本机 Obsidian 1.14.4 的 `app.css`、用户 Baseline 主题
及插件实际 `styles.css`，包含 640 / 320 px 代码块、350 / 280 px 目标侧栏、
信息 `10`、错误/警告与多行目标。已检查浅色中文、深色英文和窄栏布局，并修正错误状态颜色
及行列文字对比度。临时预览和第三方样式副本已移出项目目录。

这是浏览器中的宿主样式集成预览，**不是运行 Obsidian 桌面程序的验收**，
也没有通过模拟数据重新验证 Lean 的证明行为。

## session 版本实际结果

2026-10-21 00:50（Asia/Taipei），Windows x64 / Node.js v25.9.0 / Lean 4.35.0 / Lake 5.0.0，
开启 `LEAN_SMOKE=1` 后运行完整 `npm run check`，
命令退出码为 0：

| 项目 | 实际结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| Vitest | 18 个测试文件通过，164 个测试通过、1 个跳过，共 165 个 |
| 真实 Lean 服务 | 4 个 smoke 测试通过：gateway、完整工作区、无用户项目的基础环境、共享 session |
| 官方安装器 | 本轮跳过真实下载；2026-10-20 已通过真实私有 elan 下载/校验/安装 |
| UI 自动化 | 5 个文件、34 个测试通过：真实 CodeMirror DOM、阅读组件、目标侧栏、环境操作面板与 Host 生命周期 |
| 架构 AST 检查 | 27 个生产 TypeScript 文件通过 |
| 发布构建 | 通过，生成 `main.js` |

唯一跳过项是需要 `LEAN_BOOTSTRAP_SMOKE=1` 的官方安装器下载测试；本轮没有重新下载。
两个开关都未设置时，4 个真实 Lean 测试和这个安装器测试会跳过。
该轮没有运行真实 Obsidian 桌面验收，也没有向用户 Vault 安装插件。

## 默认自动化验证

```sh
npm run check
```

这条命令执行类型检查、默认测试、架构 AST 检查与发布构建。默认测试中的
协议故障场景使用受控的本地测试进程，不启动 Lean，也不读取用户 Vault。
其中包含服务不回应取消、挂起关闭、正常关闭后仍存活的后代进程、父进程崩溃后
仍存活的直接后代，以及初始化期间关闭文档后的迟到回调。

领域与应用测试覆盖独立块、正文移动与 UTF-16 映射、未关闭围栏的 EOF、
持续输入最大等待、过期诊断、队列容量及优先级、关闭笔记后唤醒等待工作、
慢目标的取消、旧异步响应和服务失效。

session 测试还覆盖当前笔记顺序、跨笔记和不同名称隔离、仅展示块排除、成员移动/删除/
重新分组、按文档占用队列与 worker 容量，以及前块变化后下游块自身版本不变但文档版本递增。
全篇检查过程中修改尚在排队的组或重排组，不会遗漏后续工作；服务启动失败后也会结束该轮扫描。
映射测试包含 CRLF、缩进、UTF-16、跨块范围、半开边界、零宽诊断、补入换行、空块和 EOF；
不能定位到代码的消息留在文档级，不被夹到某个代码块。
旧目标在换组或重排后，即使组合源码完全相同，也不能覆盖新位置的查询。

CodeMirror 测试使用实际的 `EditorView` 和 `keydown` DOM 事件，覆盖普通
Markdown 按键回退、Lean Unicode/缩进、未关闭围栏末尾、关闭围栏边界、
只读/不可编辑视图、释放笔记以及异步诊断装饰更新。Host 测试覆盖分屏共同持有、
异步读取与新编辑竞争、阅读视图卸载，以及连续保存配置/卸载之间的竞争。
阅读视图测试使用真实 `LeanReadingBlock` 与公共 API 替身，覆盖检查按钮、诊断显示、
重复内容按 section 定位、仅展示块及共享笔记的释放。session 的 UI 测试验证后块发起检查时
仍发送完整有序文档，重复代码在不同 session 中按 section 区分；诊断只展示在所属块，
上游修改后清除旧结果；目标面板显示 session 操作，状态按文档去重计数。

这些测试不会启动 Obsidian，也不会验证 Obsidian 主题、真实窗口布局或完整菜单交互。

新增默认环境测试覆盖：新配置直接选择基础环境且无需项目路径、旧配置保留高级项目、
仅探测不下载、准备操作去重、取消与重试、安装后恢复最新检查意图，以及准备中切换环境
或卸载时不再启动旧工作区。安装命令分支通过受控替身验证，不把这些替身当作真实下载。

围栏属性测试覆盖 `check` / `title` / `session`、单双引号、Unicode、转义、重复和无效属性、
仅改标题时身份与版本保持不变、策略改变时版本递增，以及阅读视图中相同正文但不同属性
的块按原文位置区分。

## 真实 Lean 服务结果

2026-10-20 使用 Lean 4.35.0 / Lake 5.0.0 通过真实服务 smoke 测试。
测试项目路径本身包含空格，覆盖了：

- 两个独立文档定义相同名字，各自正常检查。
- 第二块改成类型错误后，第一块不出现错误。
- 获取目标时返回局部假设 `n : Nat` 和目标 `n = n`。
- 导入已经构建的项目依赖，并验证普通项的 `plainTermGoal` 回退查询。
- 修复代码后清除诊断，关闭块后拒绝目标查询。
- 重启服务后重新打开文档，最后释放服务。
- 项目中没有生成 `ObsidianBlock_*.lean` 源文件。

2026-10-20 另外完成了 Windows x64 上的两项真实基础环境验证：

- 从空的临时缓存开始，不提供用户 Lake 项目，自动生成基础环境并复用本机已有 Lean；
  两个独立块均成功 `import Std`、检查同名定义和查询目标。
- 实际下载约 2.5 MB 的官方 elan 4.2.4 发行包、核对摘要，并安装到临时私有目录。
  安装后可以运行 elan，且尚未安装 Lean 工具链；用户原有 `elan/settings.toml` 内容未变。

这两项验证分别覆盖空缓存的真实检查和私有 elan 的真实下载。**没有为了验证重新下载
完整的 Lean 大工具链**；该安装命令分支有默认自动化测试覆盖，但不宣称已经完成
“完全未安装 Lean 的机器上从下载到证明检查”的全流程实测。

服务本身可能维护 `.lake` 元数据；“不写源文件”不意味着 Lake 完全不写项目目录。
此结果覆盖该版本的协议，不代表所有历史 Lean 4 版本都已验证。

2026-10-21 新增的共享 session 真实 smoke 已通过，使用相同工具链和已构建的 fixture，
没有下载工具链。它从后面的证明块发起检查，验证前面的 `double` 定义可见、能读取目标，
并把 `rfl` 错误准确映回原笔记。把前块从 `n + n` 改为 `n + n + 1` 后，
下游自身代码版本不变，文档版本增加并得到新的检查结果；修复证明后诊断清除。
同时验证同篇不同 session、不同笔记同名 session、仅展示块、无名独立块，以及
后块中的 `import` 按原位报错而没有被自动提升。

默认测试不会启动真实 Lean，以免没有该工具链的环境隐式下载。
确认本机已有 fixture 中声明的 Lean 4.35.0 后，在 PowerShell 中显式运行：

```powershell
Push-Location 'tests/fixtures/lean project'
lake build
Pop-Location
$env:LEAN_SMOKE = '1'
npm.cmd test -- tests/infrastructure/LeanGateway.smoke.test.ts tests/application/ProofWorkspace.smoke.test.ts tests/infrastructure/ManagedLeanEnvironment.smoke.test.ts tests/infrastructure/LeanSessionWorkspace.smoke.test.ts
Remove-Item Env:LEAN_SMOKE
```

macOS / Linux shell：

```sh
(cd 'tests/fixtures/lean project' && lake build)
LEAN_SMOKE=1 npm test -- tests/infrastructure/LeanGateway.smoke.test.ts tests/application/ProofWorkspace.smoke.test.ts tests/infrastructure/ManagedLeanEnvironment.smoke.test.ts tests/infrastructure/LeanSessionWorkspace.smoke.test.ts
```

实际服务路径分别由
[LeanGateway.smoke.test.ts](../tests/infrastructure/LeanGateway.smoke.test.ts) 和
[ProofWorkspace.smoke.test.ts](../tests/application/ProofWorkspace.smoke.test.ts) 覆盖。
工作区 smoke 还会通过真实服务检查整篇笔记的有界会话、重复名称隔离、`sorry` 警告、
跨块引用错误、仅展示块、目标查询、正文插入后的诊断映射、重启及关闭笔记。
新增 [ManagedLeanEnvironment.smoke.test.ts](../tests/infrastructure/ManagedLeanEnvironment.smoke.test.ts)
覆盖不提供项目路径的基础环境。
[LeanSessionWorkspace.smoke.test.ts](../tests/infrastructure/LeanSessionWorkspace.smoke.test.ts)
覆盖整篇笔记内的显式共享、上游修改和上下文隔离。

私有 elan 下载测试单独由 `LEAN_BOOTSTRAP_SMOKE=1` 开启，默认关闭，执行时需要访问
官方发行包。它只在临时目录安装 elan，不下载完整 Lean 工具链：

```powershell
$env:LEAN_BOOTSTRAP_SMOKE = '1'
npm.cmd test -- tests/infrastructure/ManagedLeanEnvironment.smoke.test.ts
Remove-Item Env:LEAN_BOOTSTRAP_SMOKE
```

准备好 fixture 后，包含全部真实服务、但不重新下载私有 elan 的完整验证命令为：

```powershell
$env:LEAN_SMOKE = '1'
npm.cmd run check
Remove-Item Env:LEAN_SMOKE
```

需要同时验证私有 elan 下载时，额外开启其独立开关：

```powershell
$env:LEAN_SMOKE = '1'
$env:LEAN_BOOTSTRAP_SMOKE = '1'
npm.cmd run check
Remove-Item Env:LEAN_SMOKE
Remove-Item Env:LEAN_BOOTSTRAP_SMOKE
```

## 桌面验收步骤

使用 [独立代码块示范](../examples/独立代码块示范.md)、
[共享 session 示范](<../examples/共享 session 示范.md>) 和
[另一篇同名 session 笔记](<../examples/session 跨笔记隔离.md>)，依次检查：

| 场景 | 预期 |
| --- | --- |
| 新配置、普通笔记、不填写项目路径 | 自动检测基础环境；没有工具链时提示 Prepare Lean |
| 准备过程中取消或切换环境 | 停止旧准备，不重新打开旧工作区 |
| 只修改 `title` | 标题更新，代码版本与已检查结果保持 |
| `check=off`、错误属性或未知属性 | 不发送 Lean 检查；属性错误有说明 |
| 两个无 session 块重复定义 `answer` | 两块均独立检查，没有重复定义冲突 |
| 一个无 session 块有类型错误 | 错误定位到本块，其他独立块仍可检查 |
| 无 session 块引用另一个块的声明 | 报未知标识符，证明没有隐式拼接 |
| 首次直接检查 session 的后块 | 能使用前块定义，不需要先点击前块 |
| 修改、移动或删除 session 前块 | 同组后续上下文按当前笔记重新检查，不沿用点击历史 |
| 同组 `check=off` 草稿有导入、定义或错误 | 不进入共享上下文 |
| 修改 session 名称、移除属性 | 按新归属检查，旧目标与诊断不串组 |
| 两篇笔记使用同名 session 和同名定义 | 上下文彼此隔离 |
| 只修改 session 外正文或块标题 | 诊断位置更新，Lean 文档版本不增加 |
| session 前块有错误、当前块无自身错误 | 当前块不冒领其他块的诊断，另外显示 session 错误信息 |
| 后块才写 import | 按原顺序显示 Lean 错误，不自动提升导入 |
| 代码前插入一段说明文字 | 诊断位置跟随源文本，代码版本不因说明文字而增加 |
| 编辑代码后立即移动光标 | 旧诊断和旧目标不覆盖新状态 |
| 移动、复制、删除代码块 | 状态和错误不会绑定到不相关的块 |
| 同一笔记分屏、切换其他笔记 | 活动块和目标属于正确的笔记 |
| 不完整或故意错误的展示示例 | 只展示块不会被送入 Lean 检查 |
| 阅读视图切换到编辑视图 | 状态可解释，历史结果不伪装成当前检查 |
| 重启服务，禁用插件 | 旧会话被释放，插件可以重新建立连接 |
| Lake 路径无效、项目无效 | 有可读的启动失败提示，不无声卡住 |
| 运行全篇检查 | 后台并发受限，编辑活动块仍可交互 |

以上是复现步骤，**不是已经完成的 Obsidian 实测声明**。
测试阶段没有修改用户的测试笔记或配置。本轮依照用户授权更新已安装插件的
`main.js`、`manifest.json`、`styles.css` 三个文件，更新前已备份，
部署后文件摘要与构建产物一致；安装完成不等于上述桌面交互已经验收。
