"use client"

import { Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { JsonSchemaDraft } from "@/lib/types"
import {
  createEmptySchemaField,
  ensureSchemaDraft,
  getSchemaPreview,
} from "@/lib/schema-utils"
import { downloadJson } from "@/lib/export-utils"

type SchemaWorkspaceProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  value?: JsonSchemaDraft
  onChange: (next: JsonSchemaDraft) => void
}

export function SchemaWorkspace({
  open,
  onOpenChange,
  value,
  onChange,
}: SchemaWorkspaceProps) {
  const draft = ensureSchemaDraft(value)

  function update(next: JsonSchemaDraft) {
    onChange(next)
  }

  function updateField(
    fieldId: string,
    updater: (field: JsonSchemaDraft["fields"][number]) => JsonSchemaDraft["fields"][number]
  ) {
    update({
      ...draft,
      fields: draft.fields.map((field) =>
        field.id === fieldId ? updater(field) : field
      ),
    })
  }

  function addField() {
    update({
      ...draft,
      fields: [...draft.fields, createEmptySchemaField()],
    })
  }

  function removeField(fieldId: string) {
    update({
      ...draft,
      fields: draft.fields.filter((field) => field.id !== fieldId),
    })
  }

  function exportSchemaJson() {
    const preview = getSchemaPreview(draft)
    if (!preview) return
    downloadJson(
      `${(draft.title || "response_schema").replace(/\s+/g, "_")}.json`,
      preview
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-screen sm:w-[96vw] lg:w-[92vw] xl:w-[88vw] 2xl:w-[84vw] max-w-none overflow-y-auto p-0"
      >
      <div className="mx-auto w-full max-w-[1800px] p-6">
        <SheetHeader>
          <SheetTitle>Schema Workspace</SheetTitle>
          <SheetDescription>
            Build a structured output schema for OCR / extraction / form tasks.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <div className="space-y-2">
            <div className="text-sm font-medium">Schema Name</div>
            <Input
              value={draft.title ?? ""}
              onChange={(e) =>
                update({
                  ...draft,
                  title: e.target.value,
                })
              }
              placeholder="ResponseSchema"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Fields</div>
              <Button type="button" onClick={addField} className="rounded-full">
                <Plus className="mr-2 h-4 w-4" />
                Add Field
              </Button>
            </div>

            <div className="w-full overflow-x-auto rounded-2xl border bg-background">
              <table className="w-full min-w-[980px] border-collapse text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="border-b px-3 py-2 text-left">Field Name</th>
                    <th className="border-b px-3 py-2 text-left">Type</th>
                    <th className="border-b px-3 py-2 text-left">Required</th>
                    <th className="border-b px-3 py-2 text-left">Enum</th>
                    <th className="border-b px-3 py-2 text-left">Description</th>
                    <th className="border-b px-3 py-2 text-left">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {draft.fields.length > 0 ? (
                    draft.fields.map((field) => (
                      <tr key={field.id} className="align-top">
                        <td className="border-b px-3 py-2">
                          <Input
                            value={field.name}
                            onChange={(e) =>
                              updateField(field.id, (prev) => ({
                                ...prev,
                                name: e.target.value,
                              }))
                            }
                            placeholder="e.g. invoice_number"
                          />
                        </td>

                        <td className="border-b px-3 py-2">
                          <Select
                            value={field.type}
                            onValueChange={(value) =>
                              updateField(field.id, (prev) => ({
                                ...prev,
                                type: value as
                                  | "string"
                                  | "number"
                                  | "boolean"
                                  | "array"
                                  | "object",
                              }))
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="string">string</SelectItem>
                              <SelectItem value="number">number</SelectItem>
                              <SelectItem value="boolean">boolean</SelectItem>
                              <SelectItem value="array">array</SelectItem>
                              <SelectItem value="object">object</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>

                        <td className="border-b px-3 py-2">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={field.required}
                              onChange={(e) =>
                                updateField(field.id, (prev) => ({
                                  ...prev,
                                  required: e.target.checked,
                                }))
                              }
                            />
                            Required
                          </label>
                        </td>

                        <td className="border-b px-3 py-2">
                          <Input
                            value={field.enumValues?.join(", ") ?? ""}
                            onChange={(e) =>
                              updateField(field.id, (prev) => ({
                                ...prev,
                                enumValues: e.target.value
                                  .split(",")
                                  .map((item) => item.trim())
                                  .filter(Boolean),
                              }))
                            }
                            placeholder="A, B, C"
                          />
                        </td>

                        <td className="border-b px-3 py-2">
                          <Input
                            value={field.description ?? ""}
                            onChange={(e) =>
                              updateField(field.id, (prev) => ({
                                ...prev,
                                description: e.target.value,
                              }))
                            }
                            placeholder="Describe this field"
                          />
                        </td>

                        <td className="border-b px-3 py-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => removeField(field.id)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-3 py-8 text-center text-sm text-muted-foreground"
                      >
                        No fields yet. Add one to start building your schema.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-medium">Preview</div>
              <Button
                type="button"
                variant="outline"
                className="rounded-full"
                onClick={exportSchemaJson}
              >
                Export Schema JSON
              </Button>
            </div>

            <pre className="overflow-x-auto rounded-2xl border bg-muted/40 p-4 text-xs">
              {JSON.stringify(getSchemaPreview(draft), null, 2)}
            </pre>
          </div>
        </div>
      </div>
      </SheetContent>
    </Sheet>
  )
}
