# 同名 session 在另一篇笔记中

这篇笔记与 [共享 session 示范](<共享 session 示范.md>) 使用相同的 session 名 `arithmetic`，
但它们是两个不同的上下文。这篇笔记不需要导入或先检查另一篇笔记。

```lean session=arithmetic title="另一篇笔记自己的定义"
def base : Nat := 99
```

```lean session=arithmetic title="另一篇笔记自己的证明"
example : base = 99 := by
  rfl
```

直接点击第二块的 **Check session** 应该可以检查整组。把另一篇笔记的 `base`
改成任何值，都不应改变这里的定义。
