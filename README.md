# Chat Studio

Chat Studio is a modern multimodal chat workspace built on top of an OpenAI-compatible backend.

It combines real-time streaming chat, compare mode, multimodal input, browser-side conversation memory, and structured extraction workflows in a single interface.

## Highlights

- Streaming chat with real-time token rendering
- Model selection through an OpenAI-compatible provider
- Custom system prompt
- Adjustable generation parameters
- Think / Instant mode
- Compare 2 / Compare 3 responses
- Regenerate and Edit & Resend
- Stop generation
- Browser-based short-term memory
- Image upload
- PDF upload with page-to-image parsing
- Markdown rendering
- Collapsible reasoning display
- Structured output mode
- Schema Workspace for extraction tasks
- Export structured results as JSON / CSV

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment variables

Create a `.env.local` file in the project root:

```env
OPENAI_COMPAT_BASE_URL=http://127.0.0.1:8080/v1
OPENAI_COMPAT_API_KEY=your_api_key
DEFAULT_MODEL=qwen3.5-27b
MODEL_LIST=qwen3.5-4b,qwen3.5-27b
APP_TITLE=Chat Studio
```

### 3. Start the development server

```bash
npm run dev
```

Open the app in your browser:

```text
http://localhost:3000
```

## Usage

### Basic Chat

1. Select a model
2. Enter a prompt
3. Adjust settings if needed
4. Send the request
5. View the streaming result

### Compare Mode

1. Choose `Compare 2` or `Compare 3`
2. Send one prompt
3. Review multiple outputs side by side

### Multimodal Chat

1. Drag images or PDFs into the composer
2. Add optional text instructions
3. Send the request
4. Review the generated response

### Structured Extraction

1. Switch `Output Mode` to `Structured`
2. Open `Schema Workspace`
3. Define extraction fields
4. Upload an image or PDF
5. Send the request
6. Export the result as JSON or CSV

## Security

- Provider configuration is stored on the server side through `.env.local`
- API keys are not exposed to the browser
- `.env.local` should never be committed to version control

## Architecture

Chat Studio is implemented as a full-stack Next.js application.

### Frontend

The frontend is built with the App Router and a three-panel layout:

- **Conversation Sidebar** for local chat sessions
- **Chat Panel** for streaming responses and compare mode
- **Settings Panel** for model, prompt, generation, and structured output controls

### Backend Proxy

The browser does not call the model provider directly.

Instead, the application uses Next.js Route Handlers as a server-side proxy:

- `/api/models`
- `/api/chat`

This keeps provider configuration on the server side and prevents API keys from being exposed to the client.

### Streaming Flow

The request pipeline works as follows:

1. The user sends a prompt from the browser
2. The frontend sends the request to `/api/chat`
3. The server forwards the request to an OpenAI-compatible backend
4. The provider streams partial output back
5. The frontend renders the response incrementally

### Multimodal Flow

- Images are loaded in the browser and attached to the user message
- PDFs are parsed into page images with PDF.js
- These attachments are forwarded through the existing OpenAI-compatible request format

### Conversation Memory

Short-term memory is stored locally in the browser using `localStorage`.

This enables:

- persistent chat history across refreshes
- multiple local conversations
- lightweight session management without a database

### Structured Extraction

Structured mode is separated from normal chat mode.

When enabled:

1. The user opens the Schema Workspace
2. A schema is defined through a table-based UI
3. The schema is attached to the chat request
4. The model returns structured JSON
5. The result can be exported as JSON or CSV

## Features

### Chat

- Streaming text generation
- Markdown rendering
- Reasoning / thinking collapse
- Stop generation
- Regenerate
- Edit & Resend

### Control

- Model selection
- System prompt editing
- Temperature adjustment
- Think / Instant toggle
- Compare mode selection

### Multimodal

- Image upload
- PDF upload
- PDF page parsing to image attachments
- Attachment preview in composer and chat history

### Structured Output

- Normal / Structured output mode
- Schema Workspace
- Table-based schema editing
- JSON preview
- JSON export
- CSV export

## Project Structure

```text
README.md
public/
└── pdf.worker.min.mjs
src/
├── app/
│   ├── api/
│   │   ├── chat/
│   │   │   └── route.ts
│   │   └── models/
│   │       └── route.ts
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── app-shell.tsx
│   ├── attachment-dropzone.tsx
│   ├── chat-panel.tsx
│   ├── composer.tsx
│   ├── conversation-sidebar.tsx
│   ├── markdown-renderer.tsx
│   ├── mode-toggle.tsx
│   ├── schema-workspace.tsx
│   ├── settings-panel.tsx
│   ├── theme-provider.tsx
│   └── ui/
│
├── hooks/
│   ├── use-chat-session.ts
│   ├── use-conversations.ts
│   └── use-models.ts
│
└── lib/
    ├── attachments.ts
    ├── export-utils.ts
    ├── file-utils.ts
    ├── pdf.ts
    ├── provider.ts
    ├── schema-utils.ts
    ├── storage.ts
    ├── types.ts
    └── utils.ts
```

## Dependencies

### Core

- [Next.js](https://nextjs.org/)
- [React](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)

### UI

- [Tailwind CSS](https://tailwindcss.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Radix UI](https://www.radix-ui.com/)
- [lucide-react](https://github.com/lucide-icons/lucide)

### Chat / Rendering

- [react-markdown](https://github.com/remarkjs/react-markdown)
- [remark-gfm](https://github.com/remarkjs/remark-gfm)

### File Handling

- [react-dropzone](https://react-dropzone.js.org/)
- [pdfjs-dist / PDF.js](https://github.com/mozilla/pdf.js)

## Notes

- This project is designed for OpenAI-compatible backends
- Multimodal behavior depends on backend model capability
- Large PDFs may take longer to parse because each page is converted to an image