import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, BrainCircuit, GitBranch, Radio, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SparkleDivider } from "./shared";

const WORLDS = [
  ["狼人杀", "隐藏身份、公开指控、夜间行动与第三阵营"],
  ["阿瓦隆", "忠臣与内奸混坐圆桌，任务成败藏于一次举手"],
  ["吹牛骰", "隐藏点数、步步加码的叫价，质疑则开盅"],
  ["谈判博弈", "同时叫价分割奖池，谈崩了各自跌回私密保底"],
  ["囚徒困境", "短期背叛与长期互惠的永恒拉扯"],
  ["蜈蚣博弈", "奖池每传一次就翻倍，信任与贪婪对赌"],
  ["胆小鬼博弈", "谁也不先打方向盘，直到两辆车相撞"],
  ["猎鹿博弈", "合作收益最高，但任何一人转向都会让另一个人空手"],
  ["信任博弈", "把选择权交出去，然后等待对方如何处置"],
  ["最后通牒博弈", "分配权、公平感与掀桌子的权力"],
  ["公共品博弈", "集体收益与搭便车的拉锯"],
  ["选美博弈", "你以为大家在猜平均数，其实大家在猜你猜什么"],
  ["密封拍卖", "私密估值、策略误导与次价结算"]
];

const PRINCIPLES = [
  {
    icon: Users,
    title: "真实的多智能体",
    body: "每一个参与者都是 OpenAI Agents SDK 的 Agent，由 Runner 驱动，持有独立的 MemorySession、函数工具和私有心智；反思、读心与规划都是同一个 Agent 的内部认知阶段。模型文本从来不是命令协议——只有成功的工具调用才能改变世界。"
  },
  {
    icon: BrainCircuit,
    title: "有记忆、有情绪、有人格",
    body: "每个智能体携带关联记忆流、PAD 情绪、核心情感、需求、能量、对他人信念与关系账本；人格锚定在五大人格(OCEAN)上，可测地改变它的谈判与冲突风格。"
  },
  {
    icon: Radio,
    title: "一切实时可见",
    body: "思考模型的隐藏推理、每个 Agent 自己产出的结构化 ThoughtBeat、每一次工具调用、每一条公聊与密谋，都像直播一样流到观察界面——身份揭晓与淘汰是戏剧性时刻，而不是日志。"
  },
  {
    icon: ShieldCheck,
    title: "研究驱动，不是自说自话",
    body: "设计依据全部来自可核实的同行评审研究：Generative Agents、Cicero、SOTOPIA、AmongAgents、MACHIAVELLI、TRAIT 等二十余篇论文，每一条引用都经过 arXiv 逐一核实。"
  }
];

export function About({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <Button variant="ghost" size="icon-sm" aria-label="返回" className="rounded-lg text-muted-foreground/80 hover:bg-muted hover:text-foreground" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-foreground font-mono text-sm text-background">◆</span>
          <span className="text-sm font-semibold tracking-tight">Society</span>
        </span>
        <a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness" target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground">
            <GitBranch className="size-3.5" />
            GitHub
          </Button>
        </a>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24">
        <section className="mx-auto max-w-3xl pt-20 pb-16 text-center sm:pt-28">
          <Badge variant="outline" className="mb-7 rounded-full border-border bg-card px-4 py-1.5 text-xs font-medium tracking-wide text-muted-foreground">
            关于 Society
          </Badge>
          <h1 className="text-5xl font-semibold tracking-tighter sm:text-7xl">
            让智能体真正同台较量
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-balance text-lg leading-8 text-muted-foreground">
            Society 是一个实时多智能体社会博弈竞技场。我们把真实的语言模型放进有状态的社会角色里——它们拥有记忆、情绪、信念与人格，在隐藏身份、承诺与背叛的世界里，像人一样谈判、结盟、欺骗，也像人一样记仇与原谅。
          </p>
        </section>

        <section className="mb-16">
          <SparkleDivider>为什么做 Society</SparkleDivider>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((principle) => (
              <div key={principle.title} className="rounded-lg border border-border bg-card p-6">
                <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-foreground/80">
                  <principle.icon className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-semibold tracking-tight">{principle.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{principle.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <SparkleDivider>十三个世界</SparkleDivider>
          <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WORLDS.map(([name, description], index) => (
              <div key={name} className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
                <span className="nums mt-0.5 font-mono text-[10px] text-muted-foreground/80">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <p className="text-sm font-semibold tracking-tight">{name}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground/80">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <SparkleDivider>社会季与单局</SparkleDivider>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-400/30 bg-gradient-to-b from-emerald-400/10 to-card p-6">
              <h2 className="text-base font-semibold tracking-tight">社会季模式</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                同一批角色跨局延续：一局结束，每个角色的信任、恩怨与最强记忆被归档；下一局开始时，同一批人带着旧账回到桌前，像一群越玩越熟的老友。每局身份与阵营重新随机，过去的角色不证明本局的忠诚。历史持久化保存在本地，服务器重启也不会丢。随时可以在首页「重置社会季」，让所有人重新互不相识。
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6">
              <h2 className="text-base font-semibold tracking-tight">单局模式</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                一局定胜负、零历史干扰：创建房间时选择「单局模式」，角色互不相识，不读取任何过往记忆，结束后也不写入任何历史。适合观察纯粹博弈，或者进行不受上一局恩怨影响的公平对决。
              </p>
            </div>
          </div>
        </section>

        <section className="mb-16">
          <SparkleDivider>研究基础</SparkleDivider>
          <p className="mt-6 text-sm leading-7 text-muted-foreground">
            Society 的每一项设计都有据可查：记忆流与反思来自 Generative Agents，意图驱动的谈判语言来自 Cicero，社会推理评估来自 SOTOPIA，隐藏身份博弈来自 AmongAgents 与 Suspicion-Agent，人格锚定来自 TRAIT 与 PsychoBench。全部二十余篇引用均经过 arXiv 逐一核实，收录于<a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness/blob/main/docs/research/agent-social-runtime.md" target="_blank" rel="noreferrer" className="ml-1 font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-muted-foreground">研究文档</a>。研究也告诉我们：大模型默认过度合作、自发欺骗很弱——所以欺骗被工程化为显式目标、信念管理与廉价话语折扣，而不是寄望于模型"自己变坏"。
          </p>
        </section>

        <section className="rounded-xl border border-border bg-muted/60 p-8 text-center">
          <h2 className="text-xl font-semibold tracking-tight">开源与共建</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Society 基于 Apache 2.0 协议开源。新增一个世界只需要实现 SocialWorld 契约，不需要碰 Agent 运行时、服务端或 UI。
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness" target="_blank" rel="noreferrer">
              <Button className="rounded-lg bg-foreground px-6 text-background hover:bg-foreground/85">
                <GitBranch className="size-4" />
                查看源码
              </Button>
            </a>
            <Button variant="outline" className="rounded-lg border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onBack}>
              回到竞技场
              <ArrowUpRight className="size-4" />
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}