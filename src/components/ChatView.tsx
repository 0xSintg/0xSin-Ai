import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js";
import {
  messages, activeConversationId, isStreaming, isViewingActiveStream,
  streamingText, streamingThinking, streamingImages, streamingCodeBlocks,
  streamingCodeResults, chatError, sendMessage, stopStreaming, selectConversation,
  activeConversation, retryMessage, editMessage, branchToNewChat, navigateBranch,
  branchState, selectedModel, setSelectedModel, searchEnabled, setSearchEnabled,
  urlContextEnabled, setUrlContextEnabled, codeExecutionEnabled, setCodeExecutionEnabled,
  fileUploadError, setFileUploadError, pendingAttachments, hasPendingUploads,
  addAttachment, removeAttachment, clearAttachments, loadAttachmentsFromParts,
  restoreAttachments, recoveryText, recoveryAttachments, setRecoveryText,
  setRecoveryAttachments, clampUrlContextForModel,
} from "../lib/stores/chat";
import type { Message, MessagePart } from "../lib/db";
import { AVAILABLE_MODELS, modelSupportsCodeExecution, modelSupportsUrlContext } from "../lib/api/types";
import { renderMarkdown } from "../lib/markdown";
import {
  customInstructions, activeInstructionIds, createCustomInstruction,
  updateCustomInstruction, deleteCustomInstruction, toggleInstructionActive,
} from "../lib/stores/custom-instructions";
import {
  thinkingEnabled, setThinkingEnabled, thinkingLevel, setThinkingLevel,
  usesLevelBasedThinking, modelSupportsThinking, modelAlwaysThinking,
  getModelThinkingLevels, clampThinkingLevelForModel,
} from "../lib/stores/thinking";
import { sidebarOpen, setSidebarOpen } from "../App";
import { isTauri, isAndroid } from "../lib/platform";
import type { AndroidFsUri } from "tauri-plugin-android-fs-api";
import "./ChatView.css";
import { getFileTypeInfo, formatBytes } from "./fileTypeInfo";

import {
  SUGGESTIONS, MORNING_GROUPS, AFTERNOON_GROUPS, EVENING_GROUPS, NIGHT_GROUPS,
  type ContextGroup,
} from "./chat-constants";

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}
function getGreetingAndSubtitle(): { greeting: string; subtitle: string } {
  const hour = new Date().getHours();
  let pool: ContextGroup[];
  if (hour < 5) pool = NIGHT_GROUPS;
  else if (hour < 12) pool = MORNING_GROUPS;
  else if (hour < 17) pool = AFTERNOON_GROUPS;
  else if (hour < 22) pool = EVENING_GROUPS;
  else pool = NIGHT_GROUPS;
  const group = pickRandom(pool);
  return { greeting: pickRandom(group.greetings), subtitle: pickRandom(group.subtitles) };
}

// All file types claude.ai supports
const ACCEPTED_FILE_TYPES = [
  "image/*", "video/*", "audio/*",
  "application/pdf",
  "application/zip", "application/x-zip-compressed",
  "application/x-tar", "application/gzip", "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/json", "text/*",
  ".py,.js,.ts,.jsx,.tsx,.json,.csv,.md,.xml,.html,.htm,.css,.rtf,.epub",
  ".yaml,.yml,.toml,.sh,.bash,.rs,.go,.java,.cpp,.c,.h,.rb,.php,.swift,.kt",
  ".zip,.tar,.gz,.7z,.rar,.bz2,.xz,.ipynb,.sql,.graphql,.vue,.svelte",
].join(",");

const TEXT_COLLAPSE_THRESHOLD = 2500;



export default function ChatView() {
  let chatMessagesRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  let scrollPending = false;
  const scrollToBottom = () => {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      if (chatMessagesRef) chatMessagesRef.scrollTop = chatMessagesRef.scrollHeight;
    });
  };

  createEffect(() => { messages.length; streamingText(); scrollToBottom(); });

  const [toolsMenuOpen, setToolsMenuOpen] = createSignal(false);
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [instructionsMenuOpen, setInstructionsMenuOpen] = createSignal(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = createSignal(false);
  const [editingInstruction, setEditingInstruction] = createSignal<{ id?: string; name: string; content: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(null);
  const [expandedMessages, setExpandedMessages] = createSignal<Set<string>>(new Set());
  const [isDragOver, setIsDragOver] = createSignal(false);

  const { greeting, subtitle } = getGreetingAndSubtitle();
  const suggestions = pickN(SUGGESTIONS, 4);

  createEffect(() => {
    activeConversationId();
    if (untrack(editingMessageId)) {
      setEditingMessageId(null);
      clearAttachments();
      if (inputRef) { inputRef.value = ""; inputRef.style.height = "auto"; }
    }
  });

  createEffect(() => {
    const text = recoveryText();
    if (text !== null) {
      if (inputRef) {
        inputRef.value = text;
        inputRef.style.height = "auto";
        inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + "px";
      }
      restoreAttachments([...recoveryAttachments]);
      setRecoveryText(null);
      setRecoveryAttachments([]);
    }
  });

  const doSubmit = async () => {
    const input = inputRef;
    const value = input?.value?.trim();
    if (!value && pendingAttachments.length === 0) return;
    if (isStreaming()) return;
    if (hasPendingUploads()) return;
    const editId = editingMessageId();
    const text = value || "";
    input!.value = "";
    input!.style.height = "auto";
    if (editId) {
      setEditingMessageId(null);
      const atts = [...pendingAttachments];
      clearAttachments();
      await editMessage(editId, text, atts);
    } else {
      await sendMessage(text);
    }
  };

  const handleSubmit = (e: Event) => { e.preventDefault(); doSubmit(); };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSubmit(); }
    if (e.key === "Escape" && editingMessageId()) cancelEdit();
  };

  const handleFileSelect = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    for (const file of Array.from(files)) await addAttachment(file);
    input.value = "";
  };

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); setIsDragOver(false); };
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) await addAttachment(file);
  };

  const handleSuggestionClick = (label: string) => {
    if (inputRef) { inputRef.value = label; inputRef.focus(); }
  };

  const activeToolCount = () => [searchEnabled(), urlContextEnabled(), codeExecutionEnabled()].filter(Boolean).length;
  const activeInstructionCount = () => activeInstructionIds.length;

  const handleInstructionSave = async () => {
    const ep = editingInstruction();
    if (!ep || !ep.name.trim() || !ep.content.trim()) return;
    if (ep.id) await updateCustomInstruction(ep.id, { name: ep.name.trim(), content: ep.content.trim() });
    else await createCustomInstruction(ep.name.trim(), ep.content.trim(), false);
    setEditingInstruction(null);
  };

  const thinkingLabel = () => {
    if (!modelSupportsThinking(selectedModel())) return "";
    if (modelAlwaysThinking(selectedModel())) { const l = thinkingLevel(); return l.charAt(0).toUpperCase() + l.slice(1); }
    if (!thinkingEnabled()) return "Off";
    if (usesLevelBasedThinking(selectedModel())) { const l = thinkingLevel(); return l.charAt(0).toUpperCase() + l.slice(1); }
    return "";
  };

  const currentModelName = () => AVAILABLE_MODELS.find((m) => m.id === selectedModel())?.name ?? selectedModel();

  const startEdit = (msg: Message) => {
    const text = msg.parts.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");
    loadAttachmentsFromParts(msg.parts);
    setEditingMessageId(msg.id);
    if (inputRef) {
      inputRef.value = text;
      inputRef.style.height = "auto";
      inputRef.style.height = Math.min(inputRef.scrollHeight, 200) + "px";
      inputRef.focus();
    }
  };

  const cancelEdit = () => {
    setEditingMessageId(null); clearAttachments();
    if (inputRef) { inputRef.value = ""; inputRef.style.height = "auto"; }
  };

  const toggleExpanded = (msgId: string) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  };

  const getTextContent = (msg: Message) =>
    msg.parts.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");

  // === Snackbar ===
  const [snackbarMessage, setSnackbarMessage] = createSignal<string | null>(null);
  const [snackbarExiting, setSnackbarExiting] = createSignal(false);
  let snackbarDismissTimer: ReturnType<typeof setTimeout> | undefined;
  let snackbarRemoveTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => { clearTimeout(snackbarDismissTimer); clearTimeout(snackbarRemoveTimer); });

  const showSnackbar = (message: string) => {
    clearTimeout(snackbarDismissTimer); clearTimeout(snackbarRemoveTimer);
    setSnackbarExiting(false); setSnackbarMessage(message);
    snackbarDismissTimer = setTimeout(() => {
      setSnackbarExiting(true);
      snackbarRemoveTimer = setTimeout(() => { setSnackbarMessage(null); setSnackbarExiting(false); }, 200);
    }, 4000);
  };

  const downloadInlineImage = async (mimeType: string, base64Data: string, label?: string) => {
    const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const filename = label ? `${label}.${ext}` : `0xsin-ai-image-${crypto.randomUUID()}.${ext}`;
    const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
    if (isTauri() && isAndroid()) {
      const { AndroidFs, AndroidPublicGeneralPurposeDir, getAndroidApiLevel } = await import("tauri-plugin-android-fs-api");
      const apiLevel = await getAndroidApiLevel();
      if (apiLevel < 29) {
        const ok = await AndroidFs.checkPublicFilesPermission() || await AndroidFs.requestPublicFilesPermission();
        if (!ok) { showSnackbar("Storage permission denied"); return; }
      }
      let uri: AndroidFsUri | undefined;
      try {
        uri = await AndroidFs.createNewPublicFile(AndroidPublicGeneralPurposeDir.Download, filename, mimeType, { isPending: true });
        await AndroidFs.writeFile(uri, bytes);
        await AndroidFs.setPublicFilePending(uri, false);
        await AndroidFs.scanPublicFile(uri);
        showSnackbar(`${filename} saved to Downloads`);
      } catch { if (uri) await AndroidFs.removeFile(uri).catch(() => {}); showSnackbar(`Could not save ${filename}`); }
      return;
    }
    if (isTauri()) {
      try {
        const { writeFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
        await writeFile(filename, bytes, { baseDir: BaseDirectory.Download });
        showSnackbar(`${filename} saved to Downloads`); return;
      } catch {}
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: filename, style: "display:none" });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url); showSnackbar(`${filename} downloaded`);
  };

  const regenerateUserMessage = (msg: Message) => {
    if (isStreaming()) return;
    editMessage(msg.id, getTextContent(msg), undefined);
  };


  // === Generated File Download ===
  const triggerBlobDownload = (content: string, filename: string, mimeType = "text/plain") => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url, download: filename, style: "display:none",
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showSnackbar(`${filename} downloaded`);
  };

  // === Part Renderer ===
  const renderPart = (part: MessagePart, isUser: boolean, msgId: string) => {
    switch (part.type) {
      case "text": {
        const isLong = part.text.length > TEXT_COLLAPSE_THRESHOLD;
        const expanded = expandedMessages().has(msgId);
        const display = isLong && !expanded ? part.text.slice(0, TEXT_COLLAPSE_THRESHOLD) + "…" : part.text;
        return (
          <div>
            <div class="message-text" innerHTML={renderMarkdown(display)} />
            <Show when={isLong}>
              <button class="show-more-btn" type="button" onClick={() => toggleExpanded(msgId)}>
                <md-icon>{expanded ? "expand_less" : "expand_more"}</md-icon>
                {expanded ? "Show less" : `Show more ({Math.ceil(part.text.length / 100) * 100}+ chars)`}
              </button>
            </Show>
          </div>
        );
      }
      case "thinking":
        return (
          <details class="message-thinking">
            <summary class="md-typescale-label-medium thinking-label">
              <md-icon class="thinking-icon">psychology</md-icon>
              Thinking
            </summary>
            <div class="thinking-content md-typescale-body-small message-text" innerHTML={renderMarkdown(part.text)} />
          </details>
        );
      case "inlineData":
        if (isUser) return null;
        if (part.mimeType.startsWith("image/")) return (
          <div class="message-image-container">
            <img src={`data:${part.mimeType};base64,${part.data}`} alt={part.label || "Image"} class="message-image" loading="lazy" />
            <div class="image-overlay-actions">
              <button class="image-download-btn" type="button" onClick={() => downloadInlineImage(part.mimeType, part.data, part.label)}>
                <md-icon>download</md-icon>
              </button>
            </div>
          </div>
        );
        return <div class="message-file-chip"><md-icon>description</md-icon><span class="md-typescale-label-medium">{part.label || "File"}</span></div>;
      case "fileData":
        if (isUser) return null;
        return <div class="message-file-chip"><md-icon>description</md-icon><span class="md-typescale-label-medium">{(part as any).fileName || "File"}</span></div>;
      case "searchGrounding":
        if (!part.sources?.length) return null;
        return (
          <div class="search-grounding">
            <div class="search-grounding-header md-typescale-label-medium"><md-icon>travel_explore</md-icon>Sources</div>
            <div class="search-sources">
              <For each={part.sources}>{(s) => (
                <a class="search-source-chip" href={s.uri} target="_blank" rel="noopener noreferrer">
                  <md-icon>open_in_new</md-icon>
                  <span class="md-typescale-label-small">{s.title || new URL(s.uri).hostname}</span>
                </a>
              )}</For>
            </div>
          </div>
        );
      case "functionCall":
        return <div class="function-call-chip"><md-icon>functions</md-icon><span class="md-typescale-label-medium">{part.name}</span></div>;
      case "functionResponse": return null;
      case "executableCode":
        return (
          <div class="exec-code-block">
            <div class="exec-code-header md-typescale-label-small"><md-icon>terminal</md-icon><span>{part.language || "Code"}</span></div>
            <pre class="exec-code-pre"><code>{part.code}</code></pre>
          </div>
        );
      case "codeExecutionResult":
        return (
          <div class={`code-exec-result ${part.outcome === "OUTCOME_OK" ? "result-ok" : "result-error"}`}>
            <div class="code-exec-result-header md-typescale-label-small">
              <md-icon>{part.outcome === "OUTCOME_OK" ? "check_circle" : "error_outline"}</md-icon>
              <span>{part.outcome === "OUTCOME_OK" ? "Output" : part.outcome === "OUTCOME_DEADLINE_EXCEEDED" ? "Timed Out" : "Error"}</span>
            </div>
            <Show when={part.output}><pre class="code-exec-output">{part.output}</pre></Show>
          </div>
        );
      default: return null;
    }
  };

  const copyMessageText = (msg: Message) => {
    navigator.clipboard.writeText(getTextContent(msg));
    showSnackbar("Copied to clipboard");
  };

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const renderMessage = (msg: Message) => {
    const isUser = msg.role === "user";
    const isLast = () => messages[messages.length - 1]?.id === msg.id;
    const branch = () => msg.branchGroupId ? branchState[msg.branchGroupId] : undefined;
    const userAttachParts = () => isUser ? msg.parts.filter((p) => p.type === "inlineData" || p.type === "fileData") as any[] : [];
    const userTextParts = () => isUser ? msg.parts.filter((p) => p.type !== "inlineData" && p.type !== "fileData") : [];

    return (
      <div class={`message ${isUser ? "message-user" : "message-model"}`}>
        <Show when={!isUser}>
          <div class="message-avatar"><div class="avatar-icon sinai-logo" /></div>
        </Show>
        <div class="message-content-wrapper">
          <Show when={isUser && userAttachParts().length > 0}>
            <div class="user-attach-row">
              <For each={userAttachParts()}>{(part) => {
                const isImage = part.mimeType.startsWith("image/");
                const fname = part.type === "fileData" ? part.fileName : part.label;
                const info = getFileTypeInfo(part.mimeType, fname);
                const imgSrc = part.type === "fileData" ? part.preview : `data:${part.mimeType};base64,${part.data}`;
                const name = fname || info.label;
                return (
                  <div class="user-attach-item">
                    <Show when={isImage && imgSrc} fallback={
                      <div class="user-attach-file-icon" style={{ background: `${info.color}18`, border: `1px solid ${info.color}30` }}>
                        <md-icon style={{ color: info.color }}>{info.icon}</md-icon>
                      </div>
                    }>
                      <img class="user-attach-img" src={imgSrc} alt={name} loading="lazy" />
                    </Show>
                    <span class="user-attach-name md-typescale-label-small">{name}</span>
                  </div>
                );
              }}</For>
            </div>
          </Show>

          <Show when={!isUser || userTextParts().length > 0}>
            <div class={`message-bubble ${isUser ? "bubble-user" : "bubble-model"}`}>
              <For each={isUser ? userTextParts() : msg.parts}>{(part) => renderPart(part, isUser, msg.id)}</For>
            </div>
          </Show>

          <Show when={!isUser && (msg as any).generatedFiles?.length > 0}>
            <div class="generated-files-row">
              <For each={(msg as any).generatedFiles as Array<{name: string; content: string; mimeType?: string}>}>{(gf) => {
                const info = getFileTypeInfo(gf.mimeType ?? "text/plain", gf.name);
                const sizeLabel = `${gf.content.length.toLocaleString()} chars`;
                return (
                  <button
                    class="generated-file-chip"
                    type="button"
                    onClick={() => triggerBlobDownload(gf.content, gf.name, gf.mimeType)}
                  >
                    <div
                      class="gen-file-icon-wrap"
                      style={{ background: `${info.color}18`, border: `1px solid ${info.color}30` }}
                    >
                      <md-icon style={{ color: info.color }}>{info.icon}</md-icon>
                    </div>
                    <div class="gen-file-meta">
                      <span class="gen-file-name">{gf.name}</span>
                      <span class="gen-file-size">{sizeLabel} — click to download</span>
                    </div>
                    <md-icon class="gen-file-download-icon">download</md-icon>
                  </button>
                );
              }}</For>
            </div>
          </Show>
          <div class={`message-actions ${isUser ? "actions-user" : "actions-model"}`}>
            <span class="message-time md-typescale-label-small">{formatTime(msg.createdAt)}</span>
            <Show when={isUser && branch()}>{() => {
              const b = branch()!;
              return (
                <div class="branch-nav">
                  <md-icon-button class="action-btn" type="button" disabled={b.activeIndex <= 0} onClick={() => navigateBranch(msg.branchGroupId!, b.activeIndex - 1)}><md-icon>chevron_left</md-icon></md-icon-button>
                  <span class="branch-indicator md-typescale-label-small">{b.activeIndex + 1}/{b.total}</span>
                  <md-icon-button class="action-btn" type="button" disabled={b.activeIndex >= b.total - 1} onClick={() => navigateBranch(msg.branchGroupId!, b.activeIndex + 1)}><md-icon>chevron_right</md-icon></md-icon-button>
                </div>
              );
            }}</Show>
            <md-icon-button class="action-btn" type="button" onClick={() => copyMessageText(msg)}><md-icon>content_copy</md-icon></md-icon-button>
            <Show when={isUser && !isStreaming()}><md-icon-button class="action-btn" type="button" onClick={() => startEdit(msg)}><md-icon>edit</md-icon></md-icon-button></Show>
            <Show when={isUser && !isStreaming()}><md-icon-button class="action-btn" type="button" onClick={() => regenerateUserMessage(msg)}><md-icon>replay</md-icon></md-icon-button></Show>
            <Show when={!isUser && isLast() && !isStreaming()}><md-icon-button class="action-btn" type="button" onClick={() => retryMessage()}><md-icon>refresh</md-icon></md-icon-button></Show>
            <Show when={!isUser && !isStreaming()}><md-icon-button class="action-btn" type="button" onClick={() => branchToNewChat(msg.id)}><md-icon>call_split</md-icon></md-icon-button></Show>
          </div>
        </div>
      </div>
    );
  };

  const WelcomeScreen = () => (
    <div class="welcome-screen">
      <div class="welcome-content">
        <h1 class="welcome-greeting">{greeting}</h1>
        <p class="welcome-subtitle">{subtitle}</p>
        <div class="welcome-suggestions">
          <For each={suggestions}>{([icon, label]) => (
            <button class="suggestion-chip" onClick={() => handleSuggestionClick(label)}>
              <md-icon>{icon}</md-icon><span>{label}</span>
            </button>
          )}</For>
        </div>
      </div>
    </div>
  );

  const SuggestionRow = () => (
    <div class="suggestion-row">
      <For each={suggestions}>{([icon, label]) => (
        <button class="suggestion-chip" onClick={() => handleSuggestionClick(label)}>
          <md-icon>{icon}</md-icon><span>{label}</span>
        </button>
      )}</For>
    </div>
  );

  const InputArea = () => (
    <div class={`chat-input-area${isDragOver() ? " drag-over" : ""}`}
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

      <Show when={isDragOver()}>
        <div class="drop-overlay">
          <md-icon>upload_file</md-icon>
          <span class="md-typescale-label-large">Drop files to attach</span>
        </div>
      </Show>

      <Show when={pendingAttachments.length > 0}>
        <div class="attachment-strip">
          <For each={pendingAttachments}>{(att) => {
            const info = getFileTypeInfo(att.mimeType, att.file.name);
            return (
              <div class={`attachment-preview${att.uploading ? " uploading" : att.uploadError ? " upload-error" : ""}`}>
                <Show when={!att.uploading && att.preview} fallback={
                  <div class="attachment-file-icon" style={{ background: `${info.color}18`, border: `1px solid ${info.color}30` }}>
                    <Show when={att.uploading} fallback={<md-icon style={{ color: att.uploadError ? "var(--md-sys-color-error)" : info.color }}>{att.uploadError ? "error" : info.icon}</md-icon>}>
                      <div class="attachment-spinner" />
                    </Show>
                  </div>
                }>
                  <img src={att.preview} alt={att.file.name} class="attachment-thumb" />
                </Show>
                <span class="attachment-name md-typescale-label-small">{att.file.name}</span>
                <Show when={att.file.size && !att.uploadError}>
                  <span class="attachment-size md-typescale-label-small">{formatBytes(att.file.size)}</span>
                </Show>
                <Show when={att.uploadError}>
                  <span class="attachment-error-label md-typescale-label-small">{att.uploadError}</span>
                </Show>
                <button class="attachment-remove" onClick={() => removeAttachment(att.id)}><md-icon>close</md-icon></button>
              </div>
            );
          }}</For>
        </div>
      </Show>

      <Show when={fileUploadError()}>
        <div class="upload-error-banner">
          <md-icon class="upload-error-icon">error_outline</md-icon>
          <span class="md-typescale-label-medium">{fileUploadError()}</span>
          <button type="button" class="icon-btn icon-btn-sm upload-error-dismiss" onClick={() => setFileUploadError(null)}><md-icon>close</md-icon></button>
        </div>
      </Show>

      <form class="chat-form" onSubmit={handleSubmit}>
        <Show when={editingMessageId()}>
          <div class="edit-banner">
            <md-icon class="edit-banner-icon">edit</md-icon>
            <span class="md-typescale-label-medium">Editing message</span>
            <md-icon-button class="edit-banner-close" type="button" onClick={() => cancelEdit()}><md-icon>close</md-icon></md-icon-button>
          </div>
        </Show>
        <div class="input-row">
          <div class="input-field-wrapper">
            <textarea ref={inputRef} rows={1}
              placeholder={editingMessageId() ? "Edit your message..." : "Message 0xSin AI..."}
              class="chat-input" onKeyDown={handleKeyDown} disabled={isViewingActiveStream()}
              onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }}
            />
          </div>
        </div>
        <div class="input-toolbar">
          <md-icon-button type="button" aria-label="Attach files" onClick={() => fileInputRef?.click()} disabled={isViewingActiveStream()}>
            <md-icon>add</md-icon>
          </md-icon-button>
          <input ref={fileInputRef} type="file" multiple accept={ACCEPTED_FILE_TYPES} style="display:none" onChange={handleFileSelect} />

          {/* Tools */}
          <div class="toolbar-menu-anchor">
            <md-icon-button type="button" aria-label="Tools" onClick={() => setToolsMenuOpen(!toolsMenuOpen())} class={activeToolCount() > 0 ? "tools-active" : ""}>
              <md-icon>build</md-icon>
            </md-icon-button>
            <Show when={activeToolCount() > 0}><span class="tool-badge">{activeToolCount()}</span></Show>
            <Show when={toolsMenuOpen()}>
              <div class="toolbar-popup tools-popup" onClick={(e) => e.stopPropagation()}>
                <div class="popup-header md-typescale-title-small">Tools</div>
                <label class="tool-toggle">
                  <md-icon>travel_explore</md-icon><span>Google Search</span>
                  <input type="checkbox" checked={searchEnabled()} onChange={(e) => setSearchEnabled(e.currentTarget.checked)} />
                  <span class={`toggle-track ${searchEnabled() ? "on" : ""}`}><span class="toggle-thumb" /></span>
                </label>
                <Show when={modelSupportsUrlContext(selectedModel())}>
                  <label class="tool-toggle">
                    <md-icon>link</md-icon><span>URL Context</span>
                    <input type="checkbox" checked={urlContextEnabled()} onChange={(e) => setUrlContextEnabled(e.currentTarget.checked)} />
                    <span class={`toggle-track ${urlContextEnabled() ? "on" : ""}`}><span class="toggle-thumb" /></span>
                  </label>
                </Show>
                <Show when={modelSupportsCodeExecution(selectedModel())}>
                  <label class="tool-toggle">
                    <md-icon>code</md-icon><span>Code Execution</span>
                    <input type="checkbox" checked={codeExecutionEnabled()} onChange={(e) => setCodeExecutionEnabled(e.currentTarget.checked)} />
                    <span class={`toggle-track ${codeExecutionEnabled() ? "on" : ""}`}><span class="toggle-thumb" /></span>
                  </label>
                </Show>
              </div>
              <div class="popup-backdrop" onClick={() => setToolsMenuOpen(false)} />
            </Show>
          </div>

          {/* Custom Instructions */}
          <div class="toolbar-menu-anchor">
            <md-icon-button type="button" aria-label="Custom Instructions" onClick={() => { setInstructionsMenuOpen(!instructionsMenuOpen()); setEditingInstruction(null); }} class={activeInstructionCount() > 0 ? "tools-active" : ""}>
              <md-icon>tune</md-icon>
            </md-icon-button>
            <Show when={activeInstructionCount() > 0}><span class="tool-badge">{activeInstructionCount()}</span></Show>
            <Show when={instructionsMenuOpen()}>
              <div class="toolbar-popup instructions-popup" onClick={(e) => e.stopPropagation()}>
                <div class="popup-header md-typescale-title-small">
                  <span>Custom Instructions</span>
                  <button type="button" class="icon-btn" onClick={() => setEditingInstruction({ name: "", content: "" })}><md-icon>add</md-icon></button>
                </div>
                <Show when={editingInstruction()}>
                  <div class="instruction-editor">
                    <input type="text" class="instruction-editor-name" placeholder="Instruction name" value={editingInstruction()!.name} onInput={(e) => setEditingInstruction({ ...editingInstruction()!, name: e.currentTarget.value })} />
                    <textarea class="instruction-editor-content" placeholder="Instruction content..." rows={4} value={editingInstruction()!.content} onInput={(e) => setEditingInstruction({ ...editingInstruction()!, content: e.currentTarget.value })} />
                    <div class="instruction-editor-actions">
                      <button type="button" class="text-btn" onClick={() => setEditingInstruction(null)}>Cancel</button>
                      <button type="button" class="tonal-btn" onClick={handleInstructionSave}>Save</button>
                    </div>
                  </div>
                </Show>
                <Show when={customInstructions.length > 0}>
                  <div class="instruction-list">
                    <For each={customInstructions}>{(inst) => (
                      <div class="instruction-item">
                        <label class="instruction-toggle">
                          <input type="checkbox" checked={activeInstructionIds.includes(inst.id)} onChange={() => toggleInstructionActive(inst.id)} />
                          <span class={`toggle-track ${activeInstructionIds.includes(inst.id) ? "on" : ""}`}><span class="toggle-thumb" /></span>
                        </label>
                        <div class="instruction-info" onClick={() => toggleInstructionActive(inst.id)}>
                          <span class="md-typescale-body-medium">{inst.name}</span>
                          <span class="md-typescale-label-small instruction-preview">{inst.content.slice(0, 60)}{inst.content.length > 60 ? "…" : ""}</span>
                        </div>
                        <button type="button" class="icon-btn icon-btn-sm" onClick={() => setEditingInstruction({ id: inst.id, name: inst.name, content: inst.content })}><md-icon>edit</md-icon></button>
                        <button type="button" class="icon-btn icon-btn-sm" onClick={() => deleteCustomInstruction(inst.id)}><md-icon>delete</md-icon></button>
                      </div>
                    )}</For>
                  </div>
                </Show>
                <Show when={customInstructions.length === 0 && !editingInstruction()}>
                  <div class="instruction-empty md-typescale-body-small">No custom instructions yet. Add one to customize AI behavior.</div>
                </Show>
              </div>
              <div class="popup-backdrop" onClick={() => setInstructionsMenuOpen(false)} />
            </Show>
          </div>

          {/* Thinking */}
          <Show when={modelSupportsThinking(selectedModel())}>
            <div class="toolbar-menu-anchor">
              <button type="button" class={`thinking-btn ${thinkingEnabled() ? "thinking-active" : ""}`} onClick={() => setThinkingMenuOpen(!thinkingMenuOpen())}>
                <md-icon>psychology</md-icon>
                <span class="md-typescale-label-medium">{thinkingLabel()}</span>
              </button>
              <Show when={thinkingMenuOpen()}>
                <div class="toolbar-popup thinking-popup" onClick={(e) => e.stopPropagation()}>
                  <div class="popup-header md-typescale-title-small">Thinking</div>
                  <Show when={!modelAlwaysThinking(selectedModel())}>
                    <label class="tool-toggle">
                      <md-icon>psychology</md-icon><span>Enable Thinking</span>
                      <input type="checkbox" checked={thinkingEnabled()} onChange={(e) => setThinkingEnabled(e.currentTarget.checked)} />
                      <span class={`toggle-track ${thinkingEnabled() ? "on" : ""}`}><span class="toggle-thumb" /></span>
                    </label>
                  </Show>
                  <Show when={usesLevelBasedThinking(selectedModel()) && (modelAlwaysThinking(selectedModel()) || thinkingEnabled())}>
                    <div class="thinking-levels">
                      <div class="md-typescale-label-small thinking-levels-label">Thinking Level</div>
                      <div class="thinking-level-options">
                        <For each={getModelThinkingLevels(selectedModel())}>{(lvl) => (
                          <button type="button" class={`thinking-level-btn ${thinkingLevel() === lvl ? "selected" : ""}`} onClick={() => setThinkingLevel(lvl as any)}>
                            {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                          </button>
                        )}</For>
                      </div>
                    </div>
                  </Show>
                </div>
                <div class="popup-backdrop" onClick={() => setThinkingMenuOpen(false)} />
              </Show>
            </div>
          </Show>

          <div class="toolbar-spacer" />

          {/* Model selector */}
          <div class="toolbar-menu-anchor">
            <button type="button" class="model-selector-btn" onClick={() => setModelMenuOpen(!modelMenuOpen())} disabled={isViewingActiveStream()}>
              <span class="md-typescale-label-large">{currentModelName()}</span>
              <md-icon>expand_more</md-icon>
            </button>
            <Show when={modelMenuOpen()}>
              <div class="toolbar-popup model-popup" onClick={(e) => e.stopPropagation()}>
                <For each={AVAILABLE_MODELS}>{(model) => (
                  <button type="button" class={`model-option ${model.id === selectedModel() ? "selected" : ""}`}
                    onClick={() => { setSelectedModel(model.id); clampThinkingLevelForModel(model.id); clampUrlContextForModel(model.id); setModelMenuOpen(false); }}>
                    <div class="md-typescale-body-medium">{model.name}</div>
                    <Show when={model.id === selectedModel()}><md-icon class="model-check">check_circle</md-icon></Show>
                  </button>
                )}</For>
              </div>
              <div class="popup-backdrop" onClick={() => setModelMenuOpen(false)} />
            </Show>
          </div>

          <md-filled-tonal-icon-button type="button"
            aria-label={isViewingActiveStream() ? "Stop generating" : "Send message"}
            disabled={(isStreaming() && !isViewingActiveStream()) || hasPendingUploads()}
            class={`send-button ${isViewingActiveStream() ? "is-stop" : ""}`}
            onClick={() => isViewingActiveStream() ? stopStreaming() : doSubmit()}>
            <md-icon>{isViewingActiveStream() ? "stop" : editingMessageId() ? "check" : "send"}</md-icon>
          </md-filled-tonal-icon-button>
        </div>
      </form>
    </div>
  );

  return (
    <div class="chat-view">
      <div class="chat-topbar">
        <md-icon-button class="sidebar-toggle" type="button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((p) => !p)}>
          <md-icon>{sidebarOpen() ? "menu_open" : "menu"}</md-icon>
        </md-icon-button>
        <span class="md-typescale-title-medium chat-topbar-title">{activeConversation()?.title || "0xSin AI"}</span>
        <div class="topbar-spacer" />
        <Show when={activeConversationId()}>
          <md-icon-button type="button" aria-label="New chat" onClick={() => selectConversation(null)}><md-icon>edit_square</md-icon></md-icon-button>
        </Show>
      </div>

      <Show when={activeConversationId()} fallback={
        <div class="welcome-layout">
          <WelcomeScreen />
          <div class="welcome-input-group">
            <InputArea />
            <SuggestionRow />
          </div>
        </div>
      }>
        <div class="chat-messages" ref={chatMessagesRef}>
          <For each={messages}>{(msg) => renderMessage(msg)}</For>

          <Show when={isViewingActiveStream()}>
            <div class="message message-model">
              <div class="message-avatar"><div class="avatar-icon sinai-logo" /></div>
              <div class="message-bubble bubble-model">
                <Show when={streamingThinking()}>
                  <details class="message-thinking" open>
                    <summary class="md-typescale-label-medium thinking-label">
                      <md-icon class="thinking-icon thinking-pulse">psychology</md-icon>
                      Thinking...
                    </summary>
                    <div class="thinking-content md-typescale-body-small message-text" innerHTML={renderMarkdown(streamingThinking())} />
                  </details>
                </Show>
                <Show when={streamingCodeBlocks.length > 0}>
                  <For each={streamingCodeBlocks}>{(block) => (
                    <div class="exec-code-block">
                      <div class="exec-code-header md-typescale-label-small"><md-icon>terminal</md-icon><span>{block.language || "Code"}</span></div>
                      <pre class="exec-code-pre"><code>{block.code}</code></pre>
                    </div>
                  )}</For>
                </Show>
                <Show when={streamingCodeResults.length > 0}>
                  <For each={streamingCodeResults}>{(result) => (
                    <div class={`code-exec-result ${result.outcome === "OUTCOME_OK" ? "result-ok" : "result-error"}`}>
                      <div class="code-exec-result-header md-typescale-label-small">
                        <md-icon>{result.outcome === "OUTCOME_OK" ? "check_circle" : "error_outline"}</md-icon>
                        <span>{result.outcome === "OUTCOME_OK" ? "Output" : result.outcome === "OUTCOME_DEADLINE_EXCEEDED" ? "Timed Out" : "Error"}</span>
                      </div>
                      <Show when={result.output}><pre class="code-exec-output">{result.output}</pre></Show>
                    </div>
                  )}</For>
                </Show>
                <Show when={streamingImages.length > 0}>
                  <For each={streamingImages}>{(img) => (
                    <div class="message-image-container">
                      <img src={`data:${img.mimeType};base64,${img.data}`} alt="Generated" class="message-image" />
                      <div class="image-overlay-actions">
                        <button class="image-download-btn" type="button" onClick={() => downloadInlineImage(img.mimeType, img.data)}><md-icon>download</md-icon></button>
                      </div>
                    </div>
                  )}</For>
                </Show>
                <Show when={streamingText()}>
                  <div class="message-text" innerHTML={renderMarkdown(streamingText())} />
                </Show>
                <Show when={!streamingText() && !streamingThinking() && streamingCodeBlocks.length === 0 && streamingCodeResults.length === 0 && streamingImages.length === 0}>
                  <div class="typing-indicator"><span /><span /><span /></div>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={chatError()}>
            <div class="chat-error md-typescale-body-medium">
              <md-icon class="error-icon">error_outline</md-icon>{chatError()}
            </div>
          </Show>
        </div>
        <InputArea />
      </Show>

      <Show when={snackbarMessage() !== null}>
        <div class={`snackbar${snackbarExiting() ? " snackbar--exiting" : ""}`} role="status">
          <span class="snackbar-text md-typescale-body-medium">{snackbarMessage()}</span>
        </div>
      </Show>
    </div>
  );
}
