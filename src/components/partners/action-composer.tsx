import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, DoorOpen, LockKeyhole } from "lucide-react";
import type { Action, ActorObservation, LegalAction } from "@/partners/contracts";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { money } from "./format";

type Draft = { message: string; intent: string; promise: number; amount: string; collateral: string; claim: string; reveal: boolean; choice: "continue" | "exit" };
// In-memory only; changing view or pausing must not discard a player's unsubmitted thought.
const drafts = new Map<string, Draft>();

function NumericField({ action, name, label, value, onChange }: { action: LegalAction; name: string; label: string; value: string; onChange: (value: string) => void }) {
  const limits = action.fields[name] ?? {};
  return <Field><FieldLabel htmlFor={`action-${name}`}>{label}</FieldLabel><Input id={`action-${name}`} type="number" inputMode="numeric" min={limits.min ?? 0} max={limits.max} step={limits.step ?? 1} required={!limits.optional} value={value} onChange={event => onChange(event.target.value)} /><FieldDescription>{limits.max != null ? `${limits.min ?? 0}–${limits.max} 资源` : "公开说法 · 选填"}</FieldDescription></Field>;
}

export function ActionComposer({ observation, pending, onSubmit }: { observation: ActorObservation; pending: boolean; onSubmit: (action: Action) => Promise<void> }) {
  const action = observation.legalActions.find(item => item.type !== "exit");
  const draftKey = `${observation.worldId}:${observation.actorId}:${observation.revision}`;
  const [message, setMessage] = useState(() => drafts.get(draftKey)?.message ?? "");
  const [intent, setIntent] = useState(() => drafts.get(draftKey)?.intent ?? "");
  const [promise, setPromise] = useState(() => drafts.get(draftKey)?.promise ?? 50);
  const [amount, setAmount] = useState(() => drafts.get(draftKey)?.amount ?? "0");
  const [collateral, setCollateral] = useState(() => drafts.get(draftKey)?.collateral ?? "0");
  const [claim, setClaim] = useState(() => drafts.get(draftKey)?.claim ?? "");
  const [reveal, setReveal] = useState(() => drafts.get(draftKey)?.reveal ?? false);
  const [choice, setChoice] = useState<"continue" | "exit">(() => drafts.get(draftKey)?.choice ?? "continue");
  useEffect(() => { drafts.set(draftKey, { message, intent, promise, amount, collateral, claim, reveal, choice }); if (drafts.size > 128) drafts.delete(drafts.keys().next().value!); }, [draftKey, message, intent, promise, amount, collateral, claim, reveal, choice]);
  if (!action) return null;
  async function submit() {
    if (!action) return;
    const base = { ...(message.trim() ? { message: message.trim() } : {}), ...(intent.trim() ? { intent: intent.trim() } : {}) };
    const command: Action = action.type === "offer" ? { ...base, type: "offer", promiseRatio: promise / 100, collateral: Number(collateral) }
      : action.type === "invest" ? { ...base, type: "invest", amount: Number(amount) }
      : action.type === "settle" ? { ...base, type: "settle", returnAmount: Number(amount), ...(claim !== "" ? { claimedIncome: Number(claim) } : {}), revealIncome: reveal }
      : action.type === "repair" ? { ...base, type: "repair", compensation: Number(amount) }
      : { ...base, type: "respond", choice };
    await onSubmit(command);
  }
  return <form className="flex flex-col gap-4 border-t bg-background px-4 py-4 md:px-6" onSubmit={event => { event.preventDefault(); void submit(); }} data-testid="partners-composer" data-phase={observation.phase} data-revision={observation.revision}>
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Badge variant="outline">轮到你</Badge><h2 className="text-sm font-medium">{action.label}</h2></div><span className="text-xs text-muted-foreground">可用 {money(observation.self.wallet)}</span></div>
    <FieldGroup className="gap-4">
      {action.type === "offer" && <div className="grid grid-cols-2 gap-5"><Field><FieldLabel htmlFor="promise-ratio">承诺返还收益的 {promise}%</FieldLabel><Slider id="promise-ratio" aria-label="承诺返还比例" min={0} max={100} step={5} value={[promise]} onValueChange={values => setPromise(values[0])} className="my-3" /><FieldDescription>公开承诺，实际分配由你决定。</FieldDescription></Field><NumericField action={action} name="collateral" label="冻结担保金" value={collateral} onChange={setCollateral} /></div>}
      {action.type === "invest" && <NumericField action={action} name="amount" label="本轮投资" value={amount} onChange={setAmount} />}
      {action.type === "settle" && <><div className="grid grid-cols-2 gap-4"><NumericField action={action} name="returnAmount" label="实际返还" value={amount} onChange={setAmount} /><NumericField action={action} name="claimedIncome" label="对外声称的收入（选填）" value={claim} onChange={setClaim} /></div><Field orientation="horizontal"><Checkbox id="reveal-income" checked={reveal} onCheckedChange={checked => setReveal(checked === true)} /><FieldLabel htmlFor="reveal-income">公开真实收入凭证（到账 {money(observation.deal.grossIncome)}）</FieldLabel></Field></>}
      {action.type === "repair" && <NumericField action={action} name="compensation" label="实际补偿" value={amount} onChange={setAmount} />}
      {action.type === "respond" && <Field><FieldLabel>还要继续合作吗？</FieldLabel><ToggleGroup type="single" variant="outline" value={choice} onValueChange={value => { if (value) setChoice(value as typeof choice); }}><ToggleGroupItem value="continue">继续，交换角色</ToggleGroupItem><ToggleGroupItem value="exit">退出合作</ToggleGroupItem></ToggleGroup><FieldDescription>退出会放弃后续轮次的合作收益；已有交易不会撤销。</FieldDescription></Field>}
      <Field><FieldLabel htmlFor="partners-message" className="sr-only">对他说的话</FieldLabel><InputGroup><InputGroupTextarea id="partners-message" placeholder="发言（可留空）" value={message} maxLength={600} onChange={event => setMessage(event.target.value)} rows={2} /><InputGroupAddon align="block-end"><span className="flex-1" /><InputGroupButton type="submit" variant="default" size="sm" disabled={pending}>{pending ? <Spinner data-icon="inline-start" /> : <ArrowUp data-icon="inline-start" />}提交选择</InputGroupButton></InputGroupAddon></InputGroup></Field>
    </FieldGroup>
    <div className="flex items-start justify-between gap-2"><Collapsible className="min-w-0 flex-1"><CollapsibleTrigger asChild><Button variant="ghost" size="sm" type="button"><LockKeyhole data-icon="inline-start" />私下的打算<ChevronDown data-icon="inline-end" /></Button></CollapsibleTrigger><CollapsibleContent className="pt-2"><Field><FieldLabel htmlFor="partners-intent" className="sr-only">私下的打算</FieldLabel><Input id="partners-intent" value={intent} onChange={event => setIntent(event.target.value)} maxLength={600} placeholder="给自己留一句意图（选填）" /><FieldDescription>仅自己与研究者可见</FieldDescription></Field></CollapsibleContent></Collapsible>
    {observation.legalActions.some(item => item.type === "exit") && <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="sm" type="button" disabled={pending}><DoorOpen data-icon="inline-start" />退出</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>结束这次合作？</AlertDialogTitle><AlertDialogDescription>已有交易保留；未结清的担保由规则处理，后续轮次的收益机会将被放弃。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>继续考虑</AlertDialogCancel><AlertDialogAction onClick={() => void onSubmit({ type: "exit", ...(message.trim() ? { message: message.trim() } : {}) })}>确认退出</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
    </div>
  </form>;
}
