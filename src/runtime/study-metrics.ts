import type { TrialSummary } from "./studies";
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
/** Descriptive bootstrap only: no significance claim or replacement of failed observations. */
export function interval(values: number[]) {
  if (!values.length) return null;
  if (values.length < 2) return { mean: mean(values), low: null, high: null, n: values.length };
  let seed = 1729;
  const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  const samples = Array.from({ length: 1000 }, () => mean(values.map(() => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b);
  return { mean: mean(values), low: samples[25], high: samples[974], n: values.length };
}
export function summarizeTrials(trials: TrialSummary[]) {
  const groups = [...new Set(trials.map(t => `${t.mechanism}:${t.condition}:${t.agreeableness}`))].map(key => {
    const all = trials.filter(t => `${t.mechanism}:${t.condition}:${t.agreeableness}` === key);
    const valid = all.filter(t => t.status === "completed");
    return { key, planned: all.length, completed: valid.length, failed: all.filter(t => t.status === "failed").length,
      returnedShare: interval(valid.flatMap(t => t.returnedShare === undefined ? [] : [t.returnedShare])),
      investment: interval(valid.flatMap(t => t.investment === undefined ? [] : [t.investment])),
      repair: interval(valid.flatMap(t => t.repair === undefined ? [] : [t.repair])) };
  });
  const effects = [...new Set(trials.map(t => `${t.mechanism}:${t.condition}`))].map(key => {
    const low = trials.filter(t => `${t.mechanism}:${t.condition}` === key && t.agreeableness === .2);
    const pairs = low.flatMap(a => {
      const b = trials.find(t => t.mechanism === a.mechanism && t.condition === a.condition && t.repeat === a.repeat && t.agreeableness === .8 && t.context === a.context && t.effort === a.effort);
      return b?.status === "completed" && a.status === "completed" && a.returnedShare !== undefined && b.returnedShare !== undefined ? [b.returnedShare - a.returnedShare] : [];
    });
    return { key, highMinusLowReturnedShare: interval(pairs) };
  });
  return { groups, effects, note: "探索性描述；95% bootstrap 区间，未校正多重比较。缺失与失败不作为零值；种子不能固定外部模型输出。" };
}
