"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

type MarkdownRendererProps = {
  content: string
  muted?: boolean
}

export function MarkdownRenderer({
  content,
  muted = false,
}: MarkdownRendererProps) {
  return (
    <div
      className={[
        "prose prose-sm max-w-none dark:prose-invert",
        "prose-p:leading-7 prose-pre:rounded-xl prose-pre:border prose-pre:bg-muted",
        "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-table:block prose-table:w-full prose-table:overflow-x-auto",
        muted ? "text-muted-foreground" : "text-foreground",
      ].join(" ")}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-4"
            />
          ),
          pre: ({ ...props }) => (
            <pre
              {...props}
              className="overflow-x-auto rounded-xl border bg-muted p-4"
            />
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className
            if (isInline) {
              return (
                <code
                  {...props}
                  className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
                >
                  {children}
                </code>
              )
            }

            return (
              <code {...props} className={className}>
                {children}
              </code>
            )
          },
          table: ({ ...props }) => (
            <div className="overflow-x-auto">
              <table {...props} className="w-full border-collapse text-sm" />
            </div>
          ),
          th: ({ ...props }) => (
            <th
              {...props}
              className="border px-3 py-2 text-left font-medium"
            />
          ),
          td: ({ ...props }) => (
            <td {...props} className="border px-3 py-2 align-top" />
          ),
          ul: ({ ...props }) => <ul {...props} className="list-disc pl-6" />,
          ol: ({ ...props }) => <ol {...props} className="list-decimal pl-6" />,
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className="border-l-4 pl-4 italic text-muted-foreground"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
