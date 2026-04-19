import type { Metadata } from "next"
import "./globals.css"
import "katex/dist/katex.min.css"

import { ThemeProvider } from "@/components/theme-provider"
import { getAppDescription, getAppTitle } from "@/lib/app-config"

export function generateMetadata(): Metadata {
  return {
    title: getAppTitle(),
    description: getAppDescription(),
    icons: {
      icon: [{ url: "/favicon.ico", type: "image/x-icon" }],
      shortcut: "/favicon.ico",
    },
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
