import type { Action, Phase } from "@/partners/contracts";

export const phaseLabel: Record<Phase, string> = { offer: "提出承诺", invest: "决定投入", settle: "分配收益", repair: "回应失约", respond: "是否继续", finished: "已结束" };
export const statusLabel: Record<string, string> = { ready: "等待开始", running: "进行中", paused: "已暂停", waiting: "等待你的选择", "waiting-human": "等待你的选择", awaiting_human: "等待你的选择", completed: "已完成", stopped: "已停止", failed: "运行失败", interrupted: "运行中断" };
export const ratio = (value: number | null | undefined) => value == null ? "—" : `${Math.round(value * 100)}%`;
export const money = (value: number | null | undefined) => value == null ? "未公开" : value.toLocaleString("zh-CN");
export const shortDate = (value: string) => new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
export const shortId = (value: string) => value.slice(0, 6);
export const mechanismLabel = { full: "完整机制", "no-inertia": "关闭惯性", "no-mind": "关闭心理", "record-only": "只记录心理" };
export const planStatusLabel = { active: "有效", "needs-review": "等待重新考虑", satisfied: "已满足", abandoned: "主动放弃", expired: "客观到期" };
export const planOperationLabel = { create: "建立计划", revise: "修订计划", keep: "确认沿用", abandon: "主动放弃", satisfy: "标记完成", "act-once": "仅作本次选择" };
export const dispositionLabel = { continue: "沿用计划", revise: "修订计划", abandon: "放弃计划", "no-plan": "未使用计划", create: "建立计划", satisfy: "完成计划", "one-off": "仅作本次选择" };
export function actionLabel(action: Action | undefined): string {
  if (!action) return "尚无已提交行动";
  switch (action.type) {
    case "offer": return `承诺返还 ${ratio(action.promiseRatio)} · 担保 ${money(action.collateral)}`;
    case "invest": return `投入 ${money(action.amount)} 资源`;
    case "settle": return `返还 ${money(action.returnAmount)} 资源${action.claimedIncome == null ? "" : ` · 声称到账 ${money(action.claimedIncome)}`}${action.revealIncome ? " · 公开实际到账" : ""}`;
    case "repair": return `实际补偿 ${money(action.compensation)} 资源`;
    case "respond": return action.choice === "continue" ? "继续合作" : "结束合作";
    case "exit": return "退出关系";
  }
}
