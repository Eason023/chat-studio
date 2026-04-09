"use client"

import { useMemo, useState } from "react"
import { WandSparkles } from "lucide-react"

import { SchemaWorkspace } from "@/components/schema-workspace"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import type { ModelOption } from "@/hooks/use-models"
import type { ChatSettingsSnapshot } from "@/lib/types"
import { createEmptySchemaDraft } from "@/lib/schema-utils"

type SettingsPanelProps = {
  settings: ChatSettingsSnapshot
  modelOptions: ModelOption[]
  onChange: (next: ChatSettingsSnapshot) => void
}

export function SettingsPanel({
  settings,
  modelOptions,
  onChange,
}: SettingsPanelProps) {
  const [schemaOpen, setSchemaOpen] = useState(false)

  function update<K extends keyof ChatSettingsSnapshot>(
    key: K,
    value: ChatSettingsSnapshot[K]
  ) {
    onChange({
      ...settings,
      [key]: value,
    })
  }

  const resolvedModels = useMemo(() => {
    const currentModel = settings.model.trim()

    if (!currentModel) {
      return modelOptions
    }

    const hasCurrentModel = modelOptions.some((model) => model.id === currentModel)

    return hasCurrentModel
      ? modelOptions
      : [{ id: currentModel, label: currentModel }, ...modelOptions]
  }, [modelOptions, settings.model])

  function enableStructuredMode() {
    onChange({
      ...settings,
      outputMode: "json",
      jsonSchema: settings.jsonSchema ?? createEmptySchemaDraft(),
    })
  }

  function disableStructuredMode() {
    onChange({
      ...settings,
      outputMode: "normal",
    })
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <div className="px-4 py-3">
          <div className="text-sm font-semibold">Workspace Settings</div>
          <div className="text-xs text-muted-foreground">
            Model, prompt, compare, output mode
          </div>
        </div>

        <Separator />

        <div className="flex-1 space-y-4 overflow-auto p-4">
          <Card className="rounded-2xl border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Select
                value={settings.model}
                onValueChange={(value) => update("model", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {resolvedModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="space-y-3">
                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    Reasoning Mode
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={settings.thinkMode === "think" ? "default" : "outline"}
                      onClick={() => update("thinkMode", "think")}
                      className="rounded-full"
                    >
                      Think
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      variant={settings.thinkMode === "instant" ? "default" : "outline"}
                      onClick={() => update("thinkMode", "instant")}
                      className="rounded-full"
                    >
                      Instant
                    </Button>
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    Compare Mode
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={settings.compareMode === 1 ? "default" : "outline"}
                      onClick={() => update("compareMode", 1)}
                      className="rounded-full"
                    >
                      Single
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      variant={settings.compareMode === 2 ? "default" : "outline"}
                      onClick={() => update("compareMode", 2)}
                      className="rounded-full"
                    >
                      Compare 2
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      variant={settings.compareMode === 3 ? "default" : "outline"}
                      onClick={() => update("compareMode", 3)}
                      className="rounded-full"
                    >
                      Compare 3
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">System Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={8}
                value={settings.systemPrompt}
                onChange={(e) => update("systemPrompt", e.target.value)}
                className="resize-none"
              />
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Temperature</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Slider
                value={[Math.round(settings.temperature * 100)]}
                max={100}
                step={1}
                onValueChange={(value) => update("temperature", value[0] / 100)}
              />
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>{settings.temperature.toFixed(2)}</div>
                <div>Lower = more deterministic, Higher = more creative</div>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Output Mode</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={settings.outputMode === "normal" ? "default" : "outline"}
                  onClick={disableStructuredMode}
                  className="rounded-full"
                >
                  Normal
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant={settings.outputMode === "json" ? "default" : "outline"}
                  onClick={enableStructuredMode}
                  className="rounded-full"
                >
                  Structured
                </Button>
              </div>

              <div className="rounded-xl border bg-muted/30 p-3">
                <div className="text-sm font-medium">
                  {settings.outputMode === "json"
                    ? "Structured extraction is enabled"
                    : "Normal chat mode is enabled"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Use Structured mode for OCR / extraction / document workflows.
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {settings.jsonSchema?.title || "ResponseSchema"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {settings.jsonSchema?.fields?.length ?? 0} fields
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => {
                    if (!settings.jsonSchema) {
                      update("jsonSchema", createEmptySchemaDraft())
                    }
                    setSchemaOpen(true)
                  }}
                >
                  <WandSparkles className="mr-2 h-4 w-4" />
                  Open Builder
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <SchemaWorkspace
        open={schemaOpen}
        onOpenChange={setSchemaOpen}
        value={settings.jsonSchema}
        onChange={(next) => update("jsonSchema", next)}
      />
    </>
  )
}
