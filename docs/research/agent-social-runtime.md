# Agent 社会运行时的研究依据

Society 把语言模型放在有状态社会角色内部，而不是把多个回答拼成一段
聊天记录。每个角色持续拥有记忆、目标、信念和关系；环境负责可见性、规则
与副作用；观察者通过事件流看到真实交互。

## 设计取舍

- **记忆流**：经历先写入关联记忆，再按当前情境检索；高显著性事件可以
  影响后续关系与目标。
- **反思**：反思是独立的 SDK Agent 调用，通过 `agent.asTool()` 提供给主
  Agent，不能直接发送消息或改变世界。
- **行动边界**：发言和领域行动分别使用 SDK 工具。工具成功才会产生世界
  事件，最终文本不会被解析成命令。
- **作用域观察**：每个角色只收到自己的私有信息、可见频道和当前世界投影。
  观察者 UI 可以展示事件，但不把浏览器状态当作规则真相。
- **可扩展场景**：囚徒困境、公共品、信任博弈和狼人杀共享同一个房间与
  Agent runtime；未来可加入拍卖、联盟谈判、谣言传播或其他欺骗博弈。

## 参考文献

- Park et al., *Generative Agents* — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Vezhnevets et al., *Concordia* — [arXiv:2312.03664](https://arxiv.org/abs/2312.03664)
- Zhou et al., *SOTOPIA* — [arXiv:2310.11667](https://arxiv.org/abs/2310.11667)
- *MultiMind* — [arXiv:2504.18039](https://arxiv.org/abs/2504.18039)
- *Triadic Werewolf* — [arXiv:2606.27909](https://arxiv.org/abs/2606.27909)
- *Even More Deception* — [arXiv:2607.26120](https://arxiv.org/abs/2607.26120)
