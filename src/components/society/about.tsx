import type { ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, BrainCircuit, GitBranch, Radio, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SparkleDivider } from "./shared";

const WORLDS = [
  ["狼人杀", "隐藏身份、公开指控、夜间行动与第三阵营"],
  ["阿瓦隆", "忠臣与内奸混坐圆桌,任务成败藏于一次举手"],
  ["囚徒困境", "短期背叛与长期互惠的永恒拉扯"],
  ["蜈蚣博弈", "奖池每传一次就翻倍,信任与贪婪对赌"],
  ["胆小鬼博弈", "谁也不先打方向盘,直到两辆车相撞"],
  ["猎鹿博弈", "合作收益最高,但任何一人转向都会让另一个人空手"],
  ["信任博弈", "把选择权交出去,然后等待对方如何处置"],
  ["最后通牒博弈", "分配权、公平感与掀桌子的权力"],
  ["公共品博弈", "集体收益与搭便车的拉锯"],
  ["选美博弈", "你以为大家在猜平均数,其实大家在猜你猜什么"],
  ["密封拍卖", "私密估值、策略误导与次价结算"]
];

const PRINCIPLES = [
  {
    icon: Users,
    title: "真实的多智能体",
    body: "每一个参与者都是 OpenAI Agents SDK 的 Agent,由 Runner 驱动,持有独立的 MemorySession、函数工具和私有专家子智能体。模型文本从来不是命令协议——只有成功的工具调用才能改变世界。"
  },
  {
    icon: BrainCircuit,
    title: "有记忆、有情绪、有人格",
    body: "每个智能体携带关联记忆流、PAD 情绪、核心情感、需求、能量、对他人信念与关系账本;人格锚定在五大人格(OCEAN)上,可测地改变它的谈判与冲突风格。"
  },
  {
    icon: Radio,
    title: "一切实时可见",
    body: "思考模型的隐藏推理、专家子智能体的私下盘算、每一次工具调用、每一条公聊与密谋,都像直播一样流到观察界面——身份揭晓与淘汰是戏剧性时刻,而不是日志。"
  },
  {
    icon: ShieldCheck,
    title: "研究驱动,不是自说自话",
    body: "设计依据全部来自可核实的同行评审研究:Generative Agents、Cicero、SOTOPIA、AmongAgents、MACHIAVELLI、TRAIT 等二十余篇论文,每一条引用都经过 arXiv 逐一核实。"
  }
];

export function About({ onBack }: { onBack: () => void }): ReactNode {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#050505]">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-56 left-1/2 h-[560px] w-[1000px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.12),transparent)] blur-2xl" />
        <div className="absolute -right-40 top-1/3 size-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(52,211,153,0.06),transparent)] blur-2xl" />
      </div>

      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
        <Button variant="ghost" size="icon-sm" aria-label="返回" className="rounded-full text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-sm text-zinc-100">◆</span>
          <span className="text-sm font-semibold tracking-tight text-zinc-100">Society</span>
        </span>
        <a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness" target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm" className="rounded-full border-white/10 bg-white/[0.02] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200">
            <GitBranch className="size-3.5" />
            GitHub
          </Button>
        </a>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24">
        <section className="mx-auto max-w-3xl pt-20 pb-16 text-center sm:pt-28">
          <Badge variant="outline" className="mb-7 rounded-full border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-medium tracking-wide text-zinc-300">
            关于 Society
          </Badge>
          <h1 className="bg-gradient-to-b from-white via-white to-zinc-500 bg-clip-text text-5xl font-semibold tracking-tighter text-transparent sm:text-7xl">
            让智能体真正同台较量
          </h1>
          <p className="mx-auto mt-7 max-w-2xl text-balance text-lg leading-8 text-zinc-400">
            Society 是一个实时多智能体社会博弈竞技场。我们把真实的语言模型放进有状态的
            社会角色里——它们拥有记忆、情绪、信念与人格,在隐藏身份、承诺与背叛的
            世界里,像人一样谈判、结盟、欺骗,也像人一样记仇与原谅。
          </p>
        </section>

        <section className="mb-16">
          <SparkleDivider>为什么做 Society</SparkleDivider>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((principle) => (
              <div key={principle.title} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
                <span className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-zinc-200">
                  <principle.icon className="size-5" />
                </span>
                <h2 className="mt-4 text-base font-semibold tracking-tight text-zinc-100">{principle.title}</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">{principle.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <SparkleDivider>十一个世界</SparkleDivider>
          <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WORLDS.map(([name, description], index) => (
              <div key={name} className="flex items-start gap-3 rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3">
                <span className="nums mt-0.5 font-mono text-[10px] text-zinc-600">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <p className="text-sm font-semibold tracking-tight text-zinc-100">{name}</p>
                  <p className="mt-0.5 text-xs leading-5 text-zinc-500">{description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-16">
          <SparkleDivider>研究基础</SparkleDivider>
          <p className="mt-6 text-sm leading-7 text-zinc-400">
            Society 的每一项设计都有据可查:记忆流与反思来自 Generative Agents,
            意图驱动的谈判语言来自 Cicero,社会推理评估来自 SOTOPIA,隐藏身份博弈来自
            AmongAgents 与 Suspicion-Agent,人格锚定来自 TRAIT 与 PsychoBench。
            全部二十余篇引用均经过 arXiv 逐一核实,收录于
            <a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness/blob/main/docs/research/agent-social-runtime.md" target="_blank" rel="noreferrer" className="ml-1 text-zinc-200 underline decoration-zinc-600 underline-offset-4 hover:text-white">
              研究文档
            </a>
            。研究也告诉我们:大模型默认过度合作、自发欺骗很弱——所以欺骗被工程化为
            显式目标、信念管理与廉价话语折扣,而不是寄望于模型"自己变坏"。
          </p>
        </section>

        <section className="rounded-3xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
          <h2 className="text-xl font-semibold tracking-tight text-zinc-50">开源与共建</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-zinc-400">
            Society 基于 Apache 2.0 协议开源。新增一个世界只需要实现 SocialWorld 契约,
            不需要碰 Agent 运行时、服务端或 UI。
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <a href="https://github.com/multi-zhangyang/werewolf-multi-agent-social-harness" target="_blank" rel="noreferrer">
              <Button className="rounded-full bg-zinc-50 px-6 text-zinc-950 hover:bg-white">
                <GitBranch className="size-4" />
                查看源码
              </Button>
            </a>
            <Button variant="outline" className="rounded-full border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100" onClick={onBack}>
              回到竞技场
              <ArrowUpRight className="size-4" />
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}