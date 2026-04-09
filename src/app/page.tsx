"use client"

import { AppShell } from "@/components/app-shell"
import { ChatPanel } from "@/components/chat-panel"
import { ConversationSidebar } from "@/components/conversation-sidebar"
import { SettingsPanel } from "@/components/settings-panel"
import { useChatSession } from "@/hooks/use-chat-session"
import { useConversations } from "@/hooks/use-conversations"
import { useModels } from "@/hooks/use-models"

export default function Home() {
  const { models, defaultModel } = useModels()

  const {
    hydrated,
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    deleteConversation,
    selectConversation,
    updateConversationSettings,
    updateConversationTitle,
    appendMessage,
    updateMessage,
    setConversationMessages,
  } = useConversations(defaultModel)

  const {
    input,
    setInput,
    isSending,
    canSend,
    sendMessage,
    stopGeneration,
    handleComposerKeyDown,
    editingMessageId,
    beginEditMessage,
    cancelEditMessage,
    regenerateFromUserMessage,
    pendingAttachments,
    handleFilesSelected,
    removeAttachment,
    isProcessingAttachments,
  } = useChatSession({
    conversation: activeConversation,
    appendMessage,
    updateMessage,
    setConversationMessages,
    updateConversationTitle,
  })

  if (!hydrated) {
    return null
  }

  if (!activeConversation) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Recovering workspace...
      </div>
    )
  }

  return (
    <AppShell
      sidebar={
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onCreateConversation={createConversation}
          onSelectConversation={selectConversation}
          onDeleteConversation={deleteConversation}
        />
      }
      main={
        <ChatPanel
          conversation={activeConversation}
          input={input}
          onInputChange={setInput}
          onSend={sendMessage}
          onStop={stopGeneration}
          onComposerKeyDown={handleComposerKeyDown}
          canSend={canSend}
          isSending={isSending}
          isEditing={Boolean(editingMessageId)}
          onCancelEdit={cancelEditMessage}
          onEditRequest={beginEditMessage}
          onRegenerate={regenerateFromUserMessage}
          attachments={pendingAttachments}
          onFilesAccepted={handleFilesSelected}
          onRemoveAttachment={removeAttachment}
          isProcessingAttachments={isProcessingAttachments}
        />
      }
      settings={
        <SettingsPanel
          settings={activeConversation.settings}
          modelOptions={models}
          onChange={(next) =>
            updateConversationSettings(activeConversation.id, () => next)
          }
        />
      }
    />
  )
}
