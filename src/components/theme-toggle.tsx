import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme } from "./theme-provider";

export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="切换外观">{resolved === "dark" ? <Moon /> : <Sun />}</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={theme} onValueChange={value => setTheme(value as typeof theme)}><DropdownMenuRadioItem value="light"><Sun />浅色</DropdownMenuRadioItem><DropdownMenuRadioItem value="dark"><Moon />深色</DropdownMenuRadioItem><DropdownMenuRadioItem value="system"><Monitor />跟随系统</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}
