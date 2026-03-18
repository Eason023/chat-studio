import { ReactNode } from "react"

type AppShellProps = {
  sidebar: ReactNode
  main: ReactNode
  settings: ReactNode
}

export function AppShell({ sidebar, main, settings }: AppShellProps) {
  return (
    <div className="h-screen w-full overflow-hidden bg-background text-foreground">
      <div className="grid h-full grid-cols-12">
        <aside className="col-span-2 min-h-0 min-w-0 border-r border-border">
          {sidebar}
        </aside>

        <main className="col-span-7 min-h-0 min-w-0">
          {main}
        </main>

        <aside className="col-span-3 min-h-0 min-w-0 border-l border-border">
          {settings}
        </aside>
      </div>
    </div>
  )
}
