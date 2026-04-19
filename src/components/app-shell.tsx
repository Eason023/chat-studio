import { ReactNode } from "react"

type AppShellProps = {
  sidebar: ReactNode
  main: ReactNode
  settings: ReactNode
}

export function AppShell({ sidebar, main, settings }: AppShellProps) {
  return (
    <div className="h-full w-full overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-cols-[296px_minmax(0,1fr)_320px]">
        <aside className="min-h-0 min-w-0 border-r border-border">
          {sidebar}
        </aside>

        <main className="min-h-0 min-w-0">
          {main}
        </main>

        <aside className="min-h-0 min-w-0 border-l border-border">
          {settings}
        </aside>
      </div>
    </div>
  )
}
