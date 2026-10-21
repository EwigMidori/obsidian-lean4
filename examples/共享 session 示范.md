# 按需共享 Lean session

只有显式写了相同 `session` 的可检查块才会共享上下文，作用范围限于本篇笔记。
顺序取自笔记当前内容；你可以先点击第二个块检查，不必先“运行”第一个块。
未写 `session` 的块仍然独立。

## 一组连贯的定义和证明

这个 session 的第一个参与块放置导入和前置定义：

```lean session=arithmetic title="导入和定义"
import Std

def base : Nat := 40
```

说明文字不会切断 session。下面的草稿虽然写了同名 session，但 `check=off`
使它完全不参与检查；里面的重名定义和错误不会进入共享上下文：

```lean session=arithmetic check=off title="不参与共享的草稿"
def base : Nat := "故意写错"
def draftOnly : Nat := 100
```

这个块可以直接使用上方参与块定义的 `base`：

```lean session=arithmetic title="使用前面的定义"
example : base + 2 = 42 := by
  rfl
```

再往下的同名块继续看到相同上下文：

```lean4 session=arithmetic title="继续证明"
example : base = 40 := by
  rfl
```

尝试把最上方 `base` 改为 `41`。这一组后面的证明会随之重新检查；
把它改回 `40` 后，再次检查会恢复。只改标题不会改变 Lean 代码。

## 没有 session 的块仍然独立

下面故意引用 `base`，应当报告未知标识符。仅仅位于同一篇笔记中不会共享：

```lean title="独立块不能偷用其他上下文"
#check base
```

另一个 session 可以独立使用相同名字：

```lean session=another title="不同 session"
def base : Nat := 7

example : base = 7 := by
  rfl
```

## 错误会影响同组上下文

下面两块属于单独的 `errors` 组。第一块故意有错误，检查组时应提示该组存在错误，
后续结果不能被当作一段完整无误的证明；Lean 能否继续处理后面的内容由具体错误决定。
这个错误不会进入前面的 `arithmetic`、`another` 或无名独立块：

```lean session=errors title="组内上游错误"
#check thisNameDoesNotExist
```

```lean session=errors title="上游出错后的块"
example : True := by
  trivial
```

## imports 不会被挪到顶部

导入必须写在 session 第一个参与块的顶部。下面的 `late-import` 组故意反过来写，
用于观察错误；插件不会自动提升第二块的 `import`，也不会偷偷改变笔记顺序：

```lean session=late-import title="先写了声明"
def importedTooLate : Nat := 1
```

```lean session=late-import title="这个 import 位置不对"
import Std
```

如果第一个同名块标为 `check=off`，它的导入也被排除，不能替后面的参与块提供依赖。

## 跨笔记隔离

同时打开 [另一篇 session 笔记](<session 跨笔记隔离.md>)。那篇也叫 `arithmetic`，
但定义的是自己的 `base = 99`；两篇笔记的定义与错误不会相互影响。

## 手动验收

1. 先点击“使用前面的定义”的 **Check session**，确认无需先点击第一块。
2. 修改第一块的 `base`，确认同组后续证明变化，其他组保持自己的上下文。
3. 把定义块移动到证明块之后，确认检查按新位置处理，而不是保留旧点击历史。
4. 修改 `check=off` 草稿，确认它不影响 `arithmetic` 的结果。
5. 将一个块改成另一个 `session` 或取消 `session`，确认它的上下文随之改变。
6. 检查 `errors` 和 `late-import`，确认错误定位回实际所属块。
7. 重开笔记、直接检查后面的块，确认结果仍由当前笔记内容决定。
8. 同时检查两篇名为 `arithmetic` 的组，确认跨笔记隔离。
