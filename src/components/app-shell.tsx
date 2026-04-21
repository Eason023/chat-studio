import { ReactNode } from "react"
import { PanelLeftOpen, SlidersHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

type AppShellProps = {
  sidebar: ReactNode
  main: ReactNode
  settings: ReactNode
  mobileTitle?: ReactNode
}

export function AppShell({
  sidebar,
  main,
  settings,
  mobileTitle,
}: AppShellProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground md:grid md:grid-cols-[296px_minmax(0,1fr)_320px]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 md:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="rounded-full">
              <PanelLeftOpen className="mr-2 h-4 w-4" />
              Chats
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[88vw] max-w-[320px] p-0">
            <SheetHeader className="border-b">
              <SheetTitle>Conversations</SheetTitle>
              <SheetDescription>
                Open conversations and switch workspace mode.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1">{sidebar}</div>
          </SheetContent>
        </Sheet>

        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold">
            {mobileTitle ?? "Workspace"}
          </div>
          <div className="text-[11px] text-muted-foreground">Mobile layout</div>
        </div>

        <Sheet>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="rounded-full">
              <SlidersHorizontal className="mr-2 h-4 w-4" />
              Settings
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-[92vw] max-w-[360px] p-0">
            <SheetHeader className="border-b">
              <SheetTitle>Workspace Settings</SheetTitle>
              <SheetDescription>
                Model, reasoning, compare mode, and output controls.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1">{settings}</div>
          </SheetContent>
        </Sheet>
      </div>

      <aside className="hidden min-h-0 min-w-0 border-r border-border md:block">
        {sidebar}
      </aside>

      <main className="min-h-0 min-w-0 flex-1">
        {main}
      </main>

      <aside className="hidden min-h-0 min-w-0 border-l border-border md:block">
        {settings}
      </aside>
    </div>
  )
}
