# 项目 memory 入口

优先使用 `[PROJECT_MEMORY_V1 …]` 恢复材料：纲领全文、memory 地图和与实际事件对应的遗忘提醒。未注入时读取 [纲领.md](./纲领.md) 与 [memory.json](./memory.json)；随后仅按任务回顾相关节点。

当前示例仅登记纲领和 [工作记忆.md](./工作记忆.md)。纲领解释方法，不承担任务状态交接；工作记忆保存当前有效状态。代码/示例中的规则不是本项目已经启用的 hook。

## 检查与恢复

- `python3 -B scripts/check_memory.py`：检查登记文件、单根树、父节点、循环、扫描内未登记文档、容量与本地行内链接。失败返回非零。
- `python3 -B scripts/check_memory.py --hook`：读取原生事件 JSON。仅项目根目录会话的 SessionStart/PostToolUse 生效；正常静默，异常通过 additionalContext 提醒，返回成功，不阻止工具操作。未登记/断链提醒按会话去重，启动与周期维护时复查。
- `python3 -B scripts/load_memory.py --source compact`：预览恢复正文；`--hook` 处理 SessionStart 的 startup/resume/compact/clear/new，只有 compact 才说明刚压缩。
- 检查器在 PostToolUse 内调用维护脚本，默认每 50 次提醒一次，配置为 0 关闭。判断标准与流程从纲领标记区段读取，不复制第二份维护正文。

扫描仅根目录 `*.md`，AGENTS 为引导入口例外。检测覆盖与容量均由 memory.json 声明；加载器不拒绝超预算正文。链接检查不递归目标，不校验标题锚点、引用式链接和知识是否仍正确。

维护人：当前项目 agent。用户约定、事实或机制变化时更新对应唯一正文；定期维护清理失效内容，允许无须更新。编写新规则时明确 level 和实际接入状态。

接入状态：本目录仅是模板，未安装任何客户端 hook。生成配置后仍需合并、信任并验收；不得把测试通过当成客户端已启用。恢复脚本不读取未登记正文、私人凭据或历史资料。
