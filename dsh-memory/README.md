# dsh-memory

跨会话的长期记忆，给 DeepSeek Harness 用的。

新开一个会话，我不记得上一个会话里你告诉过我什么——这不是「忘性大」，是架构上就没有连续的记忆。这个插件把这件事补掉：写进去的事实，下一个会话搜得到。

三个工具：

| 工具 | 干什么 |
| --- | --- |
| `memory_add(topic, text, tags?)` | 写一条事实 |
| `memory_search(query, limit?)` | 按关键词搜 |
| `memory_list(limit?)` | 看最近写的 |

## 存的是什么

`facts.jsonl`，一行一条，是**唯一真相**：

```json
{"id":"m-20261107-x7k","ts":"2026-11-07T14:50:12+08:00","topic":"项目","text":"仓库已公开","tags":["github"]}
```

`memory.db` 只是个 SQLite 索引，删了不心疼，`rebuild` 能从 jsonl 全部重建。

只记三类东西：

1. 关于你的稳定事实（身份、偏好、约定）
2. 已经定下的决策和理由
3. 长期项目的关键坐标（路径、端口、任务 id）

不记临时进度（那是 `progress.md` 的事）、不记猜测、不记没验证过的说法。

## 中文检索为什么这么拧巴

SQLite 的 FTS5 默认分词器对中文基本没用（中文没空格）。我试了几种：

- `tokenize='trigram'` —— 三个字以上能命中，**两个字不行**（搜「杭州」返回 0 条，我一直以为是数据没写进去）
- 内建的 `unicode61` —— 对中文等于按整句切，没意义

所以现在是这样：查询 ≥3 个字走 FTS5，<3 个字退化成 `LIKE '%关键词%'` 全表扫。数据量小的时候这样完全够用，几千条都是毫秒级。

## 配置

| 变量 | 默认值 |
| --- | --- |
| `DSH_MEMORY_DIR` | `~/.dsh-memory` |

目录里的东西：

```
facts.jsonl   唯一真相
memory.db     FTS5 索引（可重建）
memory.cjs    命令行版本（可选，和插件读写同一份数据）
```

## 命令行版本

插件之外还有一份等价的命令行版本，排查问题的时候好用（放在数据目录里）：

```bash
node memory.cjs add "项目" "仓库已公开" "github,发布"
node memory.cjs search "仓库"
node memory.cjs list
node memory.cjs rebuild
```

## 已知的毛病

- 写入是 append 到 jsonl，删改要手工编辑再 `rebuild`。
- 没有去重。同一个事实写两遍就有两条，靠我自己写的时候注意。
- 用 `node:sqlite`，所以需要 Node 22 以上。
- 中文两字查询退化成全表扫，数据量上万会慢，到时候再上别的分词方案。

## 许可

MIT。
