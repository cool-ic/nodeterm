---
name: agent-memory
description: 建立或维护每个项目的 agent memory 与 rule 体系；用于解决压缩后遗忘、文档膨胀、断链和规则缺少生效机制的问题，提供 Codex/Qoder hook 脚本示例。
---

# Agent memory：纲领、入口与运行机制

先读 [完整纲领](assets/project/纲领.md)。保留 level0/1/2 的语言，区分方法论、基石 rule、例子和实际实现；例子不自动成为任务。

## 判断每条要求放在哪里

- **level0**：由程序确定性检查或执行，必须说明实际覆盖的入口和范围。检测、报警可以确定；精简质量、是否遵守提醒不能因此成为 level0。普通 hook 不等于不可绕过的安全边界。
- **level1**：由 hook、周期提醒或审阅主动送入上下文；只能提高遵守概率。注入成功不等于 agent 已理解、完成维护或永远记住。
- **level2**：按需读取的事实、经验、偏好与约定。明确用途、读取时机、维护人和更新时机，通过 level1 地图提供入口。

每次维护允许不新增内容，优先更新、合并或删除失效内容；敏感访问数据和原始历史不进入自动恢复材料。新增独立 memory 先解释用途与不能合并的理由，遵循项目已有授权约定。

## 可运行示例

[assets/project/](assets/project/) 是一个独立示例项目：

- [memory.json](assets/project/memory.json)：文档树、扫描范围、容量和维护频率。
- [AGENTS.md](assets/project/AGENTS.md)：启动入口、运行边界与验收说明。
- [工作记忆.md](assets/project/工作记忆.md)：小型 level2 节点，演示工作状态的唯一正文；不会随纲领整篇注入。
- [check_memory.py](assets/project/scripts/check_memory.py)：结构、容量、未登记文档和本地断链检测；只报警，不拦截、删除或机械登记。
- [load_memory.py](assets/project/scripts/load_memory.py)：纲领全文 + memory 地图 + 与真实事件一致的遗忘提醒。
- [maintain_memory.py](assets/project/scripts/maintain_memory.py)：每 50 次工具调用提醒维护，频率可配置；从纲领标记区段提取判断标准与流程。

脚本使用 Python 3.9+ 标准库。直接在示例目录验证：

```sh
cd skills/agent-memory/assets/project
python3 -B scripts/check_memory.py
python3 -B scripts/load_memory.py --source compact
python3 -B -m unittest discover -s scripts -p 'test_*memory.py'
```

## 接入自己的项目

1. 先核对现有文档和 hook；将示例的纲领、脚本与登记方式合并到目标项目。空项目可复制 `assets/project/` 的内容；已有项目要合并 AGENTS、memory.json 与配置，保留用户已有工作。
2. 修改示例工作记忆、purpose、扫描范围和容量，保持唯一根节点与明确归属。脚本默认以自身上一级目录为项目根，不依赖开发者机器路径。
3. 在 **macOS/Linux** 用 [hook_config.py](scripts/hook_config.py) 为目标项目生成配置片段；它只向 stdout 输出 JSON，不写配置、不改变信任：

   ```sh
   python3 skills/agent-memory/scripts/hook_config.py /absolute/project --client codex
   python3 skills/agent-memory/scripts/hook_config.py /absolute/project --client qoder
   ```

   将输出与目标 `.codex/hooks.json` 或 `.qoder/settings.json` 合并，保留其他 handler，避免重复添加。SessionStart 调检查器与恢复器，PostToolUse 调检查器并在内部累计维护频率；不会另外注册一个维护 hook。
4. Codex 的项目配置与 hook 定义均需按客户端流程审阅信任；变更定义后检查是否需要重新信任。Qoder 按客户端实际要求启用。不要把配置生成成功当成触发成功。
5. 验收真实客户端：启动能看到恢复材料；临时断链在工具结束后提醒，同批结果不反复打扰，修复后静默。分别验证 resume/compact 和维护触发；及时移除测试内容。不要为了验收全量加载项目历史。

配置生成器目前仅支持 POSIX shell；Windows 接入需另行适配和验收命令引号及 hook 契约，不能把 POSIX 命令直接移植。此 skill 是独立项目模板，不修改 Nodeterm 的桌面、服务端或移动端功能，也不会自动安装到用户仓库。

## 能力边界

- 单份与恢复总量超预算时报警；加载器继续读全文，不截断或拒绝加载。预算是可配置示例值，不是所有项目的固定限制。
- 未登记文档采用“发现 → 反省 → 归位”；扫描范围由 registry 指定，子项目与归档不会自动递归扫描。
- 断链检测仅覆盖已登记 Markdown 的本地行内链接，检查目标存在，不递归读取目标。跳过外部 URI、纯锚点、图片、代码与注释；引用式链接、HTML、裸路径、标题锚点及语义有效性不覆盖。
- 去重与计数存于系统临时目录的 SQLite，按项目/会话隔离；30 天淘汰、最多 128 会话记录，去重最近 200 次工具调用。无 session ID 时不能可靠去重；启用维护计数而缺少 ID 会明确报警。
- 维护是工具调用计数驱动，不是后台时钟，不会唤醒空闲 agent。重要信息需在仍能确认时保存；从未保存的事实无法凭注入纲领恢复。
- 冷文档检测、任务状态机、测试通过才能完成的闸门均未实现，不因纲领中的举例而自动部署。

发布前运行示例测试及 `python3 -B -m unittest discover -s skills/agent-memory/tests`。原始 manager 曾验证 Codex 的启动恢复与真实 PostToolUse 提醒；此通用副本及每个安装位置仍需按上面的客户端验收流程独立确认，Qoder/实际 compact 不继承该验收结论。
