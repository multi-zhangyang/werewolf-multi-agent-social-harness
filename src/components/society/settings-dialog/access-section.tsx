import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { storedOwnerToken, storeOwnerToken } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

export function AccessSection() {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(() => Boolean(storedOwnerToken()));
  function save(value: string) {
    try {
      storeOwnerToken(value);
      setSaved(Boolean(value.trim()));
      setToken("");
      toast.success(value.trim() ? "已保存到当前浏览器，后续操作将使用此令牌" : "已清除当前浏览器的管理令牌");
    } catch {
      toast.error("浏览器无法保存令牌，请检查站点存储设置");
    }
  }
  return <form onSubmit={event => { event.preventDefault(); if (token.trim()) save(token); }}>
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="operator-token">管理令牌</FieldLabel>
        <InputGroup>
          <InputGroupAddon><KeyRound /></InputGroupAddon>
          <InputGroupInput id="operator-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder={saved ? "已保存；填写新令牌可替换" : "填写服务的管理令牌"} aria-describedby="operator-token-help" />
        </InputGroup>
        <FieldDescription id="operator-token-help">服务启用管理令牌时，创建互动、编辑人物和修改模型需要此凭据。使用本机 .env.local 中的 SOCIETY_OPERATOR_TOKEN；保存只影响当前浏览器，不修改服务配置。</FieldDescription>
      </Field>
      <Field orientation="horizontal">
        <Button type="submit" disabled={!token.trim()}>保存管理令牌</Button>
        {saved && <Button type="button" variant="outline" onClick={() => save("")}>清除已保存令牌</Button>}
      </Field>
    </FieldGroup>
  </form>;
}
