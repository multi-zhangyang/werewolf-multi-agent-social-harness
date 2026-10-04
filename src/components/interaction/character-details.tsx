import { X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PersonalityProfile } from "./personality";
import type { Character, Memory } from "@/runtime/types";

export function CharacterDetails({ character, memories = [], onClose }: { character: Character; memories?: Memory[]; onClose?: () => void }) {
  return <Card className="character-details"><CardHeader>
    <Avatar className="mb-3 size-14" data-tone="0"><AvatarFallback>{character.name.slice(-2)}</AvatarFallback></Avatar>
    <CardTitle><h2>{character.name}</h2></CardTitle><CardDescription>{character.values.join(" · ")}</CardDescription>
    {onClose && <CardAction><Button variant="ghost" size="icon-sm" aria-label="关闭人物详情" onClick={onClose}><X /></Button></CardAction>}
  </CardHeader><CardContent>
    <Tabs defaultValue="person"><TabsList><TabsTrigger value="person">人物</TabsTrigger><TabsTrigger value="personality">倾向</TabsTrigger><TabsTrigger value="experience">经历</TabsTrigger></TabsList>
      <TabsContent value="person" className="flex flex-col gap-6 pt-5">
        {!!character.traits?.length && <div className="flex flex-wrap gap-2">{character.traits.map(t => <Badge key={t} variant="secondary">{t}</Badge>)}</div>}
        <p>{character.persona}</p><div><h3>想要的事</h3><p>{character.goals.join("；")}</p></div><div><h3>表达习惯</h3><p>{character.voice}</p></div>
        {!!character.autobiographicalAnchors?.length && <div className="flex flex-col gap-3"><h3>塑造这个人的往事 · 虚构背景</h3>{character.autobiographicalAnchors.map((a, i) => <p key={i} className="character-anchor">{a}</p>)}</div>}
      </TabsContent>
      <TabsContent value="personality" className="pt-5"><PersonalityProfile character={character} /></TabsContent>
      <TabsContent value="experience" className="flex flex-col gap-5 pt-5">{memories.length ? memories.slice(-24).reverse().map(m => <article key={m.id}><Badge variant="outline">{m.kind === "note" ? "主观笔记" : "亲历"}</Badge><time className="ml-2 text-xs text-muted-foreground">{new Date(m.at).toLocaleDateString("zh-CN")}</time><p className="mt-2">{m.text}</p></article>) : <Empty><EmptyHeader><EmptyTitle>经历还在书写</EmptyTitle><EmptyDescription>在对局中选择本人视角，或载入已有经历版本。</EmptyDescription></EmptyHeader></Empty>}</TabsContent>
    </Tabs>
  </CardContent></Card>;
}
