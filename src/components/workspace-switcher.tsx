"use client"

import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type WorkspaceOption = {
  id: string
  label: string
}

type WorkspaceSwitcherProps = {
  value: string
  options: WorkspaceOption[]
  isLoading: boolean
  error: string | null
  onValueChange: (value: string) => void
}

export function WorkspaceSwitcher({
  value,
  options,
  isLoading,
  error,
  onValueChange,
}: WorkspaceSwitcherProps) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Workspace
      </div>

      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full rounded-xl px-3" aria-label="Select workspace">
          <SelectValue placeholder="Select workspace mode" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isLoading || error ? (
        <div className="flex flex-wrap gap-2">
          {isLoading ? <Badge variant="outline">Loading modes...</Badge> : null}
          {error ? <Badge variant="destructive">Modes unavailable</Badge> : null}
        </div>
      ) : null}
    </div>
  )
}
