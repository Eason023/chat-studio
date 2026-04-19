import type { ReactNode } from "react"
import Image from "next/image"

import { cn } from "@/lib/utils"

type AppBrandProps = {
  title: string
  subtitle?: ReactNode
  className?: string
  titleClassName?: string
  iconClassName?: string
}

export function AppBrand({
  title,
  subtitle,
  className,
  titleClassName,
  iconClassName,
}: AppBrandProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <div className={cn("relative size-9 shrink-0", iconClassName)}>
        <Image
          src="/favicon.ico"
          alt=""
          fill
          sizes="36px"
          aria-hidden="true"
          className="object-contain"
        />
      </div>

      <div className="min-w-0">
        <div
          className={cn(
            "truncate text-base font-semibold tracking-tight text-foreground",
            titleClassName
          )}
        >
          {title}
        </div>
        {subtitle ? (
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
    </div>
  )
}
