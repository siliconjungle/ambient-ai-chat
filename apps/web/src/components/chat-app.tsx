"use client";

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction
} from "react";
import { createPortal } from "react-dom";
import {
  RiCheckLine,
  RiAddLine,
  RiApps2Line,
  RiArrowLeftSLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiChat3Line,
  RiCloseLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiMenuLine,
  RiPencilLine,
  RiSearchLine,
  RiTeamLine,
  RiUserAddLine,
  RiUser3Line,
  RiUserUnfollowLine
} from "react-icons/ri";

import {
  type AgentKind,
  type AppJsonValue,
  type AppPathSegment,
  type ChatMessage,
  type ChatThread,
  type ClientSnapshot,
  type ProceduralAvatar,
  type ThreadAppState,
  type ThreadSearchResult,
  type UserProfile,
  createProceduralAvatar,
  extractMessageText,
  readEmbeddedAppMessage
} from "@social/shared";

import {
  chatServerUrl,
  searchThreadMessages,
  sendCommand,
  streamAppSource
} from "../lib/chat-api";
import { getProceduralAvatarDataUrl } from "../lib/avatar-renderer";
import {
  DEFAULT_JSON5_SOURCE,
  JsonRenderSurface,
  Json5Workbench,
  JsonValueWorkbench,
  validateJson5Source
} from "./json5-form-editor";
import {
  getOrCreateProfile,
  type StoredProfile
} from "../lib/profile-store";
import { readThreadAppValue } from "../lib/thread-apps";

const reactionChoices = ["👍", "🔥", "❤️", "😂", "👀"];

type SidebarTab = "threads" | "people" | "profile";
type ConversationTab = "feed" | "apps";
type ConnectionState = "connecting" | "online" | "offline";
type AvatarSize = "xs" | "sm" | "md" | "lg";
type UserHoverPopoverPosition = {
  top: number;
  left: number;
  placement: "top" | "bottom";
};
type AppDetailMode = "view" | "edit";

export function ChatApp() {
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("threads");
  const [createThreadModalOpen, setCreateThreadModalOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [selectedFriends, setSelectedFriends] = useState<string[]>([]);
  const [friendSearch, setFriendSearch] = useState("");
  const [participantModalOpen, setParticipantModalOpen] = useState(false);
  const [deleteThreadModalOpen, setDeleteThreadModalOpen] = useState(false);
  const [deleteThreadPending, setDeleteThreadPending] = useState(false);
  const [participantsToAdd, setParticipantsToAdd] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null);
  const [conversationTab, setConversationTab] = useState<ConversationTab>("feed");
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ThreadSearchResult[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [appPickerOpen, setAppPickerOpen] = useState(false);

  const deferredFriendSearch = useDeferredValue(friendSearch);
  const deferredMessageSearchQuery = useDeferredValue(messageSearchQuery);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const appPickerRef = useRef<HTMLDivElement | null>(null);
  const messageNodeRefs = useRef(new Map<string, HTMLElement | null>());
  const hasAutoOpenedEmptyStateRef = useRef(false);
  const copiedTimeoutRef = useRef<number | null>(null);
  const selectedThread = snapshot?.threads.find(
    (thread) => thread.id === selectedThreadId
  );
  const hasActiveChats = (snapshot?.threads.length ?? 0) > 0;
  const showEmptyConversation = snapshot !== null && !hasActiveChats;
  const selectedMessages = selectedThreadId
    ? snapshot?.messagesByThread[selectedThreadId] ?? []
    : [];
  const activeApps = selectedThreadId
    ? snapshot?.appsByThread[selectedThreadId] ?? []
    : [];
  const activeAppEntries = activeApps.map((app) => ({
    app,
    snapshot: decodeThreadAppSnapshot(app)
  }));
  const activeAppEntriesById = new Map(
    activeAppEntries.map(({ app, snapshot }) => [app.id, { app, snapshot }])
  );
  const selectedApp = activeApps.find((app) => app.id === selectedAppId) ?? null;
  const selectedAppState = selectedApp
    ? activeAppEntriesById.get(selectedApp.id)?.snapshot ?? null
    : null;
  const usersById = new Map(
    snapshot?.users.map((user) => [user.id, user]) ?? []
  );
  const friendIds = new Set(snapshot?.friendIds ?? []);
  const selfUser =
    snapshot?.self ??
    (profile
      ? createFallbackUser(profile.id, profile.username, profile.kind)
      : null);
  const selectedThreadParticipants = selectedThread
    ? selectedThread.participantIds.map((participantId) =>
        getDisplayUser(usersById, participantId)
      )
    : [];
  const activeSearchResult = searchResults[activeSearchIndex] ?? null;
  const matchedMessageIds = new Set(searchResults.map((result) => result.messageId));

  useEffect(() => {
    let cancelled = false;

    getOrCreateProfile().then((storedProfile) => {
      if (!cancelled) {
        setProfile(storedProfile);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!profile) {
      return;
    }

    let isActive = true;
    let eventSource: EventSource | null = null;

    const connect = async () => {
      setConnectionState("connecting");
      setErrorMessage(null);

      try {
        await sendCommand({
          command: "profile.upsert",
          profile
        });
      } catch (error) {
        if (isActive) {
          setConnectionState("offline");
          setErrorMessage(
            error instanceof Error ? error.message : "Unable to register profile."
          );
        }
        return;
      }

      eventSource = new EventSource(
        `${chatServerUrl}/events?agentId=${encodeURIComponent(profile.id)}`
      );

      eventSource.addEventListener("snapshot", (event) => {
        const nextSnapshot = JSON.parse(event.data) as ClientSnapshot;
        startTransition(() => {
          setSnapshot(nextSnapshot);
        });
        setConnectionState("online");
      });

      eventSource.onerror = () => {
        if (isActive) {
          setConnectionState("offline");
        }
      };
    };

    void connect();

    return () => {
      isActive = false;
      eventSource?.close();
    };
  }, [profile]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (!snapshot.self && profile) {
      void sendCommand({
        command: "profile.upsert",
        profile
      }).catch(() => {
        setConnectionState("offline");
      });
      return;
    }

    if (!snapshot.threads.length) {
      setSelectedThreadId(null);
      return;
    }

    if (
      !selectedThreadId ||
      !snapshot.threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(snapshot.threads[0]?.id ?? null);
    }
  }, [profile, selectedThreadId, snapshot]);

  useEffect(() => {
    if (!showEmptyConversation) {
      hasAutoOpenedEmptyStateRef.current = false;
      return;
    }

    if (hasAutoOpenedEmptyStateRef.current) {
      return;
    }

    hasAutoOpenedEmptyStateRef.current = true;
    setSidebarOpen(true);
  }, [showEmptyConversation]);

  useEffect(() => {
    setParticipantModalOpen(false);
    setDeleteThreadModalOpen(false);
    setDeleteThreadPending(false);
    setParticipantsToAdd([]);
    setReactionTargetId(null);
    setConversationTab("feed");
    setSelectedAppId(null);
    setAppPickerOpen(false);
    setSearchOpen(false);
    setMessageSearchQuery("");
    setSearchResults([]);
    setActiveSearchIndex(0);
    setSearchError(null);
  }, [selectedThreadId]);

  useEffect(() => {
    if (conversationTab === "feed") {
      return;
    }

    setAppPickerOpen(false);
    closeSearch();
  }, [conversationTab]);

  useEffect(() => {
    if (!appPickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (appPickerRef.current?.contains(target)) {
        return;
      }

      setAppPickerOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAppPickerOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [appPickerOpen]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    searchInputRef.current?.focus();
  }, [searchOpen, selectedThreadId]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    const distanceFromBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

    if (distanceFromBottom < 160) {
      requestAnimationFrame(() => {
        scroller.scrollTo({
          top: scroller.scrollHeight,
          behavior: "smooth"
        });
        setShowJumpToLatest(false);
      });
      return;
    }

    setShowJumpToLatest(true);
  }, [selectedMessages.length, selectedThreadId]);

  useEffect(() => {
    if (!profile || !selectedThreadId) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const query = deferredMessageSearchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(null);

    searchThreadMessages({
      agentId: profile.id,
      threadId: selectedThreadId,
      query,
      limit: 40
    })
      .then((result) => {
        if (cancelled) {
          return;
        }

        setSearchResults(result.results);
        setActiveSearchIndex(0);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setSearchResults([]);
        setSearchError(
          error instanceof Error ? error.message : "Unable to search this chat."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredMessageSearchQuery, profile, selectedThreadId]);

  useEffect(() => {
    if (!activeSearchResult) {
      return;
    }

    const target = messageNodeRefs.current.get(activeSearchResult.messageId);
    target?.scrollIntoView({
      block: "center",
      behavior: "smooth"
    });
  }, [activeSearchResult]);

  const filteredDirectory = (snapshot?.users ?? []).filter((user) => {
    if (user.id === profile?.id) {
      return false;
    }

    const query = deferredFriendSearch.trim().toLowerCase();
    if (!query) {
      return true;
    }

    return (
      user.username.toLowerCase().includes(query) ||
      user.id.toLowerCase().includes(query)
    );
  });

  const availableFriendsForNewThread = (snapshot?.users ?? []).filter(
    (user) => user.id !== profile?.id && friendIds.has(user.id)
  );

  const availableFriendsForSelectedThread = selectedThread
    ? (snapshot?.users ?? []).filter(
        (user) =>
          friendIds.has(user.id) &&
          !selectedThread.participantIds.includes(user.id) &&
          user.id !== profile?.id
      )
    : [];

  async function handleCreateThread() {
    await createThread(selectedFriends, createTitle);
  }

  function resetCreateThreadDraft() {
    setCreateTitle("");
    setSelectedFriends([]);
  }

  function openCreateThreadModal() {
    resetCreateThreadDraft();
    setCreateThreadModalOpen(true);
  }

  function closeCreateThreadModal() {
    setCreateThreadModalOpen(false);
    resetCreateThreadDraft();
  }

  async function createThread(participantIds: string[], title: string) {
    if (!profile || participantIds.length === 0) {
      return;
    }

    try {
      await sendCommand({
        command: "thread.create",
        agentId: profile.id,
        title,
        participantIds
      });
      setCreateThreadModalOpen(false);
      resetCreateThreadDraft();
      setSidebarTab("threads");
      closeSidebarIfOverlay(setSidebarOpen);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to create thread."
      );
    }
  }

  async function handleDeleteThread(threadId: string) {
    if (!profile) {
      return;
    }

    try {
      setDeleteThreadPending(true);
      await sendCommand({
        command: "thread.delete",
        agentId: profile.id,
        threadId
      });
      setDeleteThreadModalOpen(false);
      setParticipantModalOpen(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to delete thread."
      );
    } finally {
      setDeleteThreadPending(false);
    }
  }

  async function handleToggleFriend(friendId: string, isFriend: boolean) {
    if (!profile) {
      return;
    }

    try {
      await sendCommand({
        command: isFriend ? "friend.remove" : "friend.add",
        agentId: profile.id,
        friendId
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to update friends."
      );
    }
  }

  async function handleStartDirectThread(friendId: string) {
    if (!profile || !snapshot) {
      return;
    }

    const existingThread = snapshot.threads.find((thread) => {
      return (
        thread.participantIds.length === 2 &&
        thread.participantIds.includes(friendId) &&
        thread.participantIds.includes(profile.id)
      );
    });

    if (existingThread) {
      setSelectedThreadId(existingThread.id);
      setSidebarTab("threads");
      closeSidebarIfOverlay(setSidebarOpen);
      return;
    }

    setCreateTitle("");
    setSelectedFriends([friendId]);
    await createThread([friendId], "");
  }

  async function handleAddParticipants() {
    if (!profile || !selectedThread || participantsToAdd.length === 0) {
      return;
    }

    try {
      await sendCommand({
        command: "thread.participants.add",
        agentId: profile.id,
        threadId: selectedThread.id,
        participantIds: participantsToAdd
      });
      setParticipantsToAdd([]);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to update participants."
      );
    }
  }

  async function handleSendMessage() {
    if (!profile || !selectedThreadId || !draft.trim()) {
      return;
    }

    const nextDraft = draft.trim();
    setDraft("");

    try {
      await sendCommand({
        command: "message.send",
        threadId: selectedThreadId,
        agentId: profile.id,
        agentKind: profile.kind,
        type: "chat.text",
        message: {
          text: nextDraft
        }
      });
      setAppPickerOpen(false);
    } catch (error) {
      setDraft(nextDraft);
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to send message."
      );
    }
  }

  async function handleSendAppEmbed(appId: string) {
    if (!profile || !selectedThreadId) {
      return;
    }

    const app = activeApps.find((candidate) => candidate.id === appId);
    if (!app) {
      setErrorMessage("App not found.");
      return;
    }

    try {
      await sendCommand({
        command: "message.send",
        threadId: selectedThreadId,
        agentId: profile.id,
        agentKind: profile.kind,
        type: "chat.app.embed",
        message: {
          appId: app.id,
          appName: app.name
        }
      });
      setAppPickerOpen(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to share app."
      );
    }
  }

  async function handleToggleReaction(messageId: string, emoji: string) {
    if (!profile || !selectedThreadId) {
      return;
    }

    try {
      await sendCommand({
        command: "message.react.toggle",
        threadId: selectedThreadId,
        messageId,
        emoji,
        agentId: profile.id
      });
      setReactionTargetId(null);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to update reaction."
      );
    }
  }

  async function handleCopyId(id: string, label: string, key: string) {
    if (!id) {
      return;
    }

    try {
      await navigator.clipboard.writeText(id);
      setCopiedKey(key);

      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }

      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
        copiedTimeoutRef.current = null;
      }, 1400);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : `Unable to copy ${label}.`
      );
    }
  }

  function scrollToLatest(behavior: ScrollBehavior) {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior
    });
    setShowJumpToLatest(false);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendMessage();
    }
  }

  function handleScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    const distanceFromBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setShowJumpToLatest(distanceFromBottom > 160);
  }

  function registerMessageNode(messageId: string, node: HTMLElement | null) {
    messageNodeRefs.current.set(messageId, node);
  }

  function jumpToSearchResult(direction: 1 | -1) {
    if (!searchResults.length) {
      return;
    }

    setActiveSearchIndex((current) => {
      const nextIndex = (current + direction + searchResults.length) % searchResults.length;
      return nextIndex;
    });
  }

  function closeSearch() {
    setSearchOpen(false);
    setMessageSearchQuery("");
    setSearchResults([]);
    setActiveSearchIndex(0);
    setSearchLoading(false);
    setSearchError(null);
  }

  async function handleCreateApp() {
    if (!selectedThreadId || !profile?.id) {
      return;
    }

    const validation = validateJson5Source(DEFAULT_JSON5_SOURCE);
    if (validation.error || validation.value === null) {
      setErrorMessage(validation.error ?? "Invalid default app source.");
      return;
    }

    try {
      const response = await sendCommand<{ outcome?: { appId?: string } }>({
        command: "thread.app.create",
        agentId: profile.id,
        threadId: selectedThreadId,
        name: "Untitled app",
        description: "",
        source: DEFAULT_JSON5_SOURCE,
        value: validation.value
      });

      setConversationTab("apps");
      if (response.outcome?.appId) {
        setSelectedAppId(response.outcome.appId);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to create app."
      );
    }
  }

  async function handleDeleteApp(appId: string) {
    if (!selectedThreadId || !profile?.id) {
      return;
    }

    try {
      await sendCommand({
        command: "thread.app.delete",
        agentId: profile.id,
        threadId: selectedThreadId,
        appId
      });

      setSelectedAppId((current) => (current === appId ? null : current));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to delete app."
      );
    }
  }

  async function handleSaveApp(
    appId: string,
    nextValues: {
      name: string;
      description: string;
      source: string;
      value: AppJsonValue;
    }
  ) {
    if (!selectedThreadId || !profile?.id) {
      throw new Error("No active thread selected.");
    }

    const currentApp = activeApps.find((app) => app.id === appId);
    if (!currentApp) {
      throw new Error("App not found.");
    }

    const nextName = nextValues.name.trim() || "Untitled app";
    const nextDescription = nextValues.description.trim();

    if (
      currentApp.name !== nextName ||
      currentApp.description !== nextDescription
    ) {
      await sendCommand({
        command: "thread.app.meta.update",
        agentId: profile.id,
        threadId: selectedThreadId,
        appId,
        name: nextName,
        description: nextDescription
      });
    }

    if (currentApp.savedSource !== nextValues.source) {
      await sendCommand({
        command: "thread.app.source.save",
        agentId: profile.id,
        threadId: selectedThreadId,
        appId,
        source: nextValues.source,
        value: nextValues.value
      });
    }
  }

  async function handleUpdateAppField(
    appId: string,
    path: AppPathSegment[],
    value: AppJsonValue
  ) {
    if (!selectedThreadId || !profile?.id) {
      return;
    }

    try {
      await sendCommand({
        command: "thread.app.form.update",
        agentId: profile.id,
        threadId: selectedThreadId,
        appId,
        path,
        value
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to update app field."
      );
    }
  }

  async function handleGenerateAppDraft(params: {
    prompt: string;
    name: string;
    description: string;
    currentSource: string;
    onDelta: (accumulated: string) => void;
  }) {
    if (!selectedThreadId || !profile?.id) {
      throw new Error("No active thread selected.");
    }

    return streamAppSource({
      agentId: profile.id,
      threadId: selectedThreadId,
      prompt: params.prompt,
      name: params.name,
      description: params.description,
      currentSource: params.currentSource,
      onDelta: (_delta, accumulated) => {
        params.onDelta(accumulated);
      }
    });
  }

  return (
    <main className="chat-page">
      <section className={`shell ${sidebarOpen ? "shell-sidebar-open" : ""}`}>
        {sidebarOpen ? (
          <button
            aria-label="Close sidebar"
            className="sidebar-scrim"
            onClick={() => setSidebarOpen(false)}
            type="button"
          />
        ) : null}

        <aside className="sidebar">
          <div className="sidebar-header">
            <div className="pill-tabs sidebar-tabs">
              <button
                aria-label="Threads"
                className={sidebarTab === "threads" ? "tab-active" : ""}
                onClick={() => setSidebarTab("threads")}
                title="Threads"
                type="button"
              >
                <RiChat3Line aria-hidden="true" />
              </button>
              <button
                aria-label="People"
                className={sidebarTab === "people" ? "tab-active" : ""}
                onClick={() => setSidebarTab("people")}
                title="People"
                type="button"
              >
                <RiTeamLine aria-hidden="true" />
              </button>
              <button
                aria-label="Profile"
                className={sidebarTab === "profile" ? "tab-active" : ""}
                onClick={() => setSidebarTab("profile")}
                title="Profile"
                type="button"
              >
                <RiUser3Line aria-hidden="true" />
              </button>
            </div>
            <button
              aria-label="Hide sidebar"
              className="ghost-button icon-button"
              onClick={() => setSidebarOpen(false)}
              type="button"
            >
              <RiArrowLeftSLine aria-hidden="true" />
            </button>
          </div>

          {sidebarTab === "threads" ? (
            <div className="sidebar-section-stack">
              <section className="panel sidebar-action-panel">
                <div className="sidebar-action-row">
                  <button
                    className="primary-button create-chat-button"
                    onClick={openCreateThreadModal}
                    type="button"
                  >
                    New chat
                  </button>
                </div>
              </section>

              <div className="thread-list sidebar-thread-list">
                {snapshot?.threads.length ? (
                  snapshot.threads.map((thread) => {
                    const active = thread.id === selectedThreadId;
                    const latestMessage =
                      snapshot.messagesByThread[thread.id]?.at(-1) ?? null;
                    const threadParticipants = thread.participantIds.map(
                      (participantId) => getDisplayUser(usersById, participantId)
                    );

                    return (
                      <button
                        className={`thread-card ${active ? "thread-card-active" : ""}`}
                        key={thread.id}
                        onClick={() => {
                          setSelectedThreadId(thread.id);
                          closeSidebarIfOverlay(setSidebarOpen);
                        }}
                        type="button"
                      >
                        <div className="thread-card-top">
                          <span className="thread-card-title">
                            {getThreadLabel(thread, usersById, profile?.id ?? "")}
                          </span>
                          <ThreadParticipantStrip participants={threadParticipants} />
                        </div>
                        <span className="thread-card-preview">
                          {latestMessage
                            ? getMessagePreview(latestMessage)
                            : "No messages yet."}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <div className="empty-state">
                    Use New chat to start a conversation.
                  </div>
                )}
              </div>
            </div>
          ) : sidebarTab === "people" ? (
            <div className="sidebar-section-stack">
              <div className="directory-panel">
                <label className="field">
                  <span>Search</span>
                  <input
                    onChange={(event) => setFriendSearch(event.target.value)}
                    placeholder="Name or id"
                    value={friendSearch}
                  />
                </label>

                <div className="directory-list">
                  {filteredDirectory.map((user) => {
                    const isFriend = friendIds.has(user.id);

                    return (
                      <div className="directory-item" key={user.id}>
                        <div className="directory-user">
                          <UserHoverAvatar
                            friendIds={friendIds}
                            selfId={profile?.id}
                            size="md"
                            user={user}
                          />

                          <div className="directory-meta">
                            <div className="directory-name-row">
                              <span style={getUserNameStyle(user)}>{user.username}</span>
                              <span className="agent-pill">{user.kind}</span>
                            </div>
                            <div className="id-row">
                              <span className="id-pill mono" title={user.id}>
                                {formatCompactId(user.id)}
                              </span>
                              <div className="copy-popover-wrap">
                                <button
                                  aria-label={`Copy ${user.username} ID`}
                                  className="ghost-button copy-id-button"
                                  onClick={() =>
                                    void handleCopyId(
                                      user.id,
                                      `${user.username} ID`,
                                      `user-id-${user.id}`
                                    )
                                  }
                                  type="button"
                                >
                                  <RiFileCopyLine aria-hidden="true" />
                                </button>

                                {copiedKey === `user-id-${user.id}` ? (
                                  <span className="copy-popover" role="status">
                                    Copied
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="directory-actions">
                          <button
                            aria-label={isFriend ? "Remove friend" : "Add friend"}
                            className="secondary-button directory-action-button"
                            onClick={() =>
                              void handleToggleFriend(user.id, isFriend)
                            }
                            title={isFriend ? "Remove friend" : "Add friend"}
                            type="button"
                          >
                            {isFriend ? (
                              <RiUserUnfollowLine aria-hidden="true" />
                            ) : (
                              <RiUserAddLine aria-hidden="true" />
                            )}
                          </button>
                          <button
                            aria-label="Open chat"
                            className="ghost-button directory-action-button"
                            disabled={!isFriend}
                            onClick={() => void handleStartDirectThread(user.id)}
                            title={isFriend ? "Open chat" : "Add friend to enable chat"}
                            type="button"
                          >
                            <RiChat3Line aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {!filteredDirectory.length ? (
                    <div className="empty-state">No people match that search.</div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="sidebar-section-stack">
              <section className="profile-card">
                <div className="profile-summary">
                  {selfUser ? <AvatarCircle size="lg" user={selfUser} /> : null}

                  <div className="profile-identity">
                    <p className="profile-name" style={getUserNameStyle(selfUser)}>
                      {profile?.username ?? "Loading..."}
                    </p>
                    <div className="id-row">
                      <span className="id-pill mono" title={profile?.id ?? ""}>
                        {formatCompactId(profile?.id ?? "...")}
                      </span>
                      <div className="copy-popover-wrap">
                        <button
                          aria-label="Copy your ID"
                          className="ghost-button copy-id-button"
                          disabled={!profile?.id}
                          onClick={() =>
                            void handleCopyId(
                              profile?.id ?? "",
                              "your ID",
                              "profile-id"
                            )
                          }
                          type="button"
                        >
                          <RiFileCopyLine aria-hidden="true" />
                        </button>

                        {copiedKey === "profile-id" ? (
                          <span className="copy-popover" role="status">
                            Copied
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}
        </aside>

        <section
          className={`conversation ${showEmptyConversation ? "conversation-empty" : ""}`}
        >
          {showEmptyConversation ? (
            <div className="conversation-empty-state">
              {!sidebarOpen ? (
                <button
                  aria-label="Expand sidebar"
                  className="hamburger conversation-empty-toggle"
                  onClick={() => setSidebarOpen(true)}
                  type="button"
                >
                  <RiMenuLine aria-hidden="true" />
                </button>
              ) : null}
              <p>you have no active chats</p>
            </div>
          ) : (
            <>
              <header
                className={`conversation-header ${
                  selectedThread && searchOpen && conversationTab === "feed"
                    ? "conversation-header-search-open"
                    : ""
                }`}
              >
                {selectedThread && searchOpen && conversationTab === "feed" ? (
                  <div className="conversation-search-shell">
                    <div className="conversation-search-top">
                      <button
                        aria-label="Close search"
                        className="ghost-button icon-button search-toggle-button"
                        onClick={closeSearch}
                        type="button"
                      >
                        <RiCloseLine aria-hidden="true" />
                      </button>

                      <label className="search-field conversation-search-field" htmlFor="chat-search">
                        <span className="search-field-icon" aria-hidden="true">
                          <RiSearchLine />
                        </span>
                        <input
                          id="chat-search"
                          onChange={(event) => setMessageSearchQuery(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              closeSearch();
                            }
                          }}
                          placeholder="Search messages"
                          ref={searchInputRef}
                          value={messageSearchQuery}
                        />
                      </label>

                      <div className="conversation-search-actions">
                        <button
                          aria-label="Previous match"
                          className="ghost-button icon-button search-match-button"
                          disabled={searchLoading || searchResults.length === 0}
                          onClick={() => jumpToSearchResult(-1)}
                          title={
                            searchResults.length
                              ? `Previous match (${activeSearchIndex + 1}/${searchResults.length})`
                              : "Previous match"
                          }
                          type="button"
                        >
                          <RiArrowUpSLine aria-hidden="true" />
                        </button>

                        <button
                          aria-label="Next match"
                          className="ghost-button icon-button search-match-button"
                          disabled={searchLoading || searchResults.length === 0}
                          onClick={() => jumpToSearchResult(1)}
                          title={
                            searchResults.length
                              ? `Next match (${activeSearchIndex + 1}/${searchResults.length})`
                              : "Next match"
                          }
                          type="button"
                        >
                          <RiArrowDownSLine aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="conversation-header-row">
                      {!sidebarOpen ? (
                        <button
                          aria-label="Expand sidebar"
                          className="hamburger"
                          onClick={() => setSidebarOpen(true)}
                          type="button"
                        >
                          <RiMenuLine aria-hidden="true" />
                        </button>
                      ) : null}

                      <div className="conversation-heading">
                        <h2>
                          {selectedThread
                            ? getThreadLabel(selectedThread, usersById, profile?.id ?? "")
                            : "Chats"}
                        </h2>
                        <p className="conversation-subtitle">
                          {selectedThread
                            ? `${selectedThreadParticipants.length} participant${
                                selectedThreadParticipants.length === 1 ? "" : "s"
                              }`
                            : "Open the sidebar and start a new chat."}
                        </p>
                      </div>
                    </div>

                    <div className="conversation-tools">
                      {selectedThread ? (
                        <ParticipantStack
                          friendIds={friendIds}
                          onOpenModal={() => setParticipantModalOpen(true)}
                          participants={selectedThreadParticipants}
                          selfId={profile?.id}
                        />
                      ) : null}

                      <span className={`status-pill status-${connectionState}`}>
                        <span className="status-dot" />
                        {connectionState}
                      </span>

                      {selectedThread && conversationTab === "feed" ? (
                        <button
                          aria-label="Search this chat"
                          className="ghost-button icon-button search-toggle-button"
                          onClick={() => setSearchOpen(true)}
                          type="button"
                        >
                          <RiSearchLine aria-hidden="true" />
                        </button>
                      ) : null}

                      {selectedThread ? (
                        <button
                          className="ghost-button danger-button"
                          onClick={() => setDeleteThreadModalOpen(true)}
                          type="button"
                        >
                          Delete
                        </button>
                      ) : null}

                      {selectedThread ? (
                        <div className="pill-tabs conversation-tabs">
                          <button
                            aria-label="Text feed"
                            className={conversationTab === "feed" ? "tab-active" : ""}
                            onClick={() => setConversationTab("feed")}
                            title="Text feed"
                            type="button"
                          >
                            <RiChat3Line aria-hidden="true" />
                          </button>
                          <button
                            aria-label="Apps"
                            className={conversationTab === "apps" ? "tab-active" : ""}
                            onClick={() => setConversationTab("apps")}
                            title="Apps"
                            type="button"
                          >
                            <RiApps2Line aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </header>

              <div
                className={`conversation-body ${
                  conversationTab === "apps" ? "conversation-body-apps" : ""
                }`}
              >
                {selectedThread ? (
                  conversationTab === "feed" ? (
                    <div
                      className="message-scroller"
                      onScroll={handleScroll}
                      ref={scrollerRef}
                    >
                      {selectedMessages.map((message) => {
                        const author = getDisplayUser(usersById, message.agentId);
                        const ownMessage = message.agentId === profile?.id;
                        const isMatched = matchedMessageIds.has(message.id);
                        const isActiveSearchHit =
                          activeSearchResult?.messageId === message.id;

                        return (
                          <article
                            className={`message-row ${ownMessage ? "message-row-self" : ""}`}
                            key={message.id}
                            ref={(node) => registerMessageNode(message.id, node)}
                          >
                            <UserHoverAvatar
                              align={ownMessage ? "end" : "start"}
                              friendIds={friendIds}
                              selfId={profile?.id}
                              size="md"
                              user={author}
                            />

                            <div
                              className={`message-card ${ownMessage ? "message-card-self" : ""} ${
                                isMatched ? "message-card-search-hit" : ""
                              } ${isActiveSearchHit ? "message-card-search-active" : ""}`}
                            >
                              <div className="message-card-header">
                                <div className="message-author-row">
                                  <span
                                    className="message-author"
                                    style={getUserNameStyle(author)}
                                  >
                                    {author.username}
                                  </span>
                                  {ownMessage ? (
                                    <span className="message-self-label">You</span>
                                  ) : null}
                                </div>
                                <time className="message-time">
                                  {formatTime(message.createdAt)}
                                </time>
                              </div>

                              <div className="message-content">
                                {renderMessage(message, {
                                  appLookup: activeAppEntriesById,
                                  onOpenApp: (appId) => {
                                    setConversationTab("apps");
                                    setSelectedAppId(appId);
                                  },
                                  onValueChange: handleUpdateAppField
                                })}
                              </div>

                              <div className="reaction-row">
                                {groupReactions(message, profile?.id).map((reaction) => (
                                  <button
                                    className={`reaction-pill ${reaction.mine ? "reaction-pill-active" : ""}`}
                                    key={reaction.emoji}
                                    onClick={() =>
                                      void handleToggleReaction(message.id, reaction.emoji)
                                    }
                                    type="button"
                                  >
                                    <span>{reaction.emoji}</span>
                                    <span>{reaction.count}</span>
                                  </button>
                                ))}

                                <div className="reaction-picker-wrap">
                                  <button
                                    className="reaction-add"
                                    onClick={() =>
                                      setReactionTargetId((current) =>
                                        current === message.id ? null : message.id
                                      )
                                    }
                                    type="button"
                                  >
                                    +
                                  </button>

                                  {reactionTargetId === message.id ? (
                                    <div className="reaction-picker">
                                      {reactionChoices.map((emoji) => (
                                        <button
                                          key={emoji}
                                          onClick={() =>
                                            void handleToggleReaction(message.id, emoji)
                                          }
                                          type="button"
                                        >
                                          {emoji}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : (
                    <AppsPane
                      apps={activeApps}
                      collaborativeValue={selectedAppState?.value ?? null}
                      collaborativeValueError={selectedAppState?.error ?? null}
                      onBack={() => setSelectedAppId(null)}
                      onCreateApp={() => void handleCreateApp()}
                      onDeleteApp={(appId) => void handleDeleteApp(appId)}
                      onGenerateSource={handleGenerateAppDraft}
                      onOpenApp={setSelectedAppId}
                      onSaveApp={(appId, nextValues) => handleSaveApp(appId, nextValues)}
                      onValueChange={handleUpdateAppField}
                      selectedApp={selectedApp}
                    />
                  )
                ) : (
                  <div className="blank-state">
                    <div className="blank-card">
                      <h3>No chat selected</h3>
                      <p>Open the sidebar and start a new chat.</p>
                    </div>
                  </div>
                )}

                {selectedThread && conversationTab === "feed" && showJumpToLatest ? (
                  <button
                    className="jump-button"
                    onClick={() => scrollToLatest("smooth")}
                    type="button"
                  >
                    Latest
                  </button>
                ) : null}
              </div>

              {conversationTab === "feed" ? (
                <footer className="composer">
                  {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

                  <div className="composer-shell">
                    <div className="composer-input-row">
                      <div className="composer-app-picker" ref={appPickerRef}>
                        <button
                          aria-expanded={appPickerOpen}
                          aria-haspopup="menu"
                          className="ghost-button icon-button composer-app-trigger"
                          disabled={!selectedThread}
                          onClick={() => setAppPickerOpen((current) => !current)}
                          title="Share app"
                          type="button"
                        >
                          <RiAddLine aria-hidden="true" />
                        </button>

                        {appPickerOpen ? (
                          <div
                            aria-label="Apps in this chat"
                            className="composer-app-menu"
                            role="menu"
                          >
                            {activeApps.length ? (
                              activeApps.map((app) => (
                                <button
                                  className="composer-app-menu-item"
                                  key={app.id}
                                  onClick={() => void handleSendAppEmbed(app.id)}
                                  role="menuitem"
                                  type="button"
                                >
                                  <span className="composer-app-menu-icon">
                                    <RiApps2Line aria-hidden="true" />
                                  </span>
                                  <span className="composer-app-menu-copy">
                                    <span className="composer-app-menu-name">{app.name}</span>
                                    {app.description ? (
                                      <span className="composer-app-menu-description">
                                        {app.description}
                                      </span>
                                    ) : null}
                                  </span>
                                </button>
                              ))
                            ) : (
                              <p className="composer-app-menu-empty">
                                No apps in this chat yet.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <textarea
                        disabled={!selectedThread}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={handleComposerKeyDown}
                        placeholder="Send a message"
                        rows={1}
                        value={draft}
                      />
                    </div>
                    <button
                      className="primary-button composer-send"
                      disabled={!selectedThread || !draft.trim()}
                      onClick={() => void handleSendMessage()}
                      type="button"
                    >
                      Send
                    </button>
                  </div>
                </footer>
              ) : null}
            </>
          )}
        </section>
      </section>

      {createThreadModalOpen ? (
        <div className="modal-layer">
          <button
            aria-label="Close new chat modal"
            className="modal-scrim"
            onClick={closeCreateThreadModal}
            type="button"
          />

          <section
            aria-modal="true"
            className="modal-card"
            role="dialog"
          >
            <div className="modal-header">
              <div>
                <h3>New chat</h3>
                <p className="panel-copy">
                  Pick one or more friends to start a conversation.
                </p>
              </div>

              <button
                className="ghost-button"
                onClick={closeCreateThreadModal}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="modal-body">
              <label className="field modal-field">
                <span>Title</span>
                <input
                  onChange={(event) => setCreateTitle(event.target.value)}
                  placeholder="Optional"
                  value={createTitle}
                />
              </label>

              <section className="modal-section create-chat-modal-section">
                <div className="panel-header">
                  <div>
                    <p className="panel-title">People</p>
                    <p className="panel-copy">
                      Only friends can be added here.
                    </p>
                  </div>
                </div>

                {availableFriendsForNewThread.length ? (
                  <div className="selection-list">
                    {availableFriendsForNewThread.map((user) => {
                      const selected = selectedFriends.includes(user.id);

                      return (
                        <button
                          className={`selection-chip ${selected ? "selection-chip-active" : ""}`}
                          key={user.id}
                          onClick={() =>
                            setSelectedFriends((current) =>
                              selected
                                ? current.filter((id) => id !== user.id)
                                : [...current, user.id]
                            )
                          }
                          type="button"
                        >
                          <AvatarCircle size="xs" user={user} />
                          <span
                            className="selection-chip-name"
                            style={getUserNameStyle(user)}
                          >
                            {user.username}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state modal-empty-state">
                    Add friends from the People tab to start a chat.
                  </div>
                )}
              </section>

              <div className="manage-actions create-chat-modal-actions">
                <button
                  className="ghost-button"
                  onClick={closeCreateThreadModal}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="primary-button create-chat-button"
                  disabled={selectedFriends.length === 0}
                  onClick={() => void handleCreateThread()}
                  type="button"
                >
                  Create chat
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {deleteThreadModalOpen && selectedThread ? (
        <div className="modal-layer">
          <button
            aria-label="Close delete chat modal"
            className="modal-scrim"
            disabled={deleteThreadPending}
            onClick={() => setDeleteThreadModalOpen(false)}
            type="button"
          />

          <section
            aria-modal="true"
            className="modal-card confirm-modal"
            role="dialog"
          >
            <div className="modal-header">
              <div>
                <h3>Delete chat</h3>
                <p className="panel-copy">
                  Delete{" "}
                  {getThreadLabel(selectedThread, usersById, profile?.id ?? "")} for
                  everyone.
                </p>
              </div>

              <button
                aria-label="Close delete chat modal"
                className="ghost-button icon-button"
                disabled={deleteThreadPending}
                onClick={() => setDeleteThreadModalOpen(false)}
                type="button"
              >
                <RiCloseLine aria-hidden="true" />
              </button>
            </div>

            <div className="modal-body confirm-modal-body">
              <p className="confirm-copy">This action cannot be undone.</p>

              <div className="manage-actions modal-actions">
                <button
                  className="secondary-button"
                  disabled={deleteThreadPending}
                  onClick={() => setDeleteThreadModalOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="ghost-button danger-button"
                  disabled={deleteThreadPending}
                  onClick={() => void handleDeleteThread(selectedThread.id)}
                  type="button"
                >
                  {deleteThreadPending ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {participantModalOpen && selectedThread ? (
        <div className="modal-layer">
          <button
            aria-label="Close people modal"
            className="modal-scrim"
            onClick={() => setParticipantModalOpen(false)}
            type="button"
          />

          <section
            aria-modal="true"
            className="modal-card"
            role="dialog"
          >
            <div className="modal-header">
              <div>
                <h3>People in this chat</h3>
                <p className="panel-copy">
                  {selectedThreadParticipants.length} participant
                  {selectedThreadParticipants.length === 1 ? "" : "s"}
                </p>
              </div>

              <button
                className="ghost-button"
                onClick={() => setParticipantModalOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="modal-body">
              <div className="participant-detail-list">
                {selectedThreadParticipants.map((user) => (
                  <article className="participant-detail-card" key={user.id}>
                    <div className="participant-detail-head">
                      <AvatarCircle size="lg" user={user} />

                      <div className="participant-detail-meta">
                        <p
                          className="participant-detail-name"
                          style={getUserNameStyle(user)}
                        >
                          {user.username}
                        </p>

                        <div className="participant-detail-badges">
                          {user.id === profile?.id ? (
                            <span className="agent-pill">you</span>
                          ) : null}
                          {friendIds.has(user.id) ? (
                            <span className="agent-pill">friend</span>
                          ) : null}
                          <span className="agent-pill">{user.kind}</span>
                        </div>
                      </div>
                    </div>

                    <p className="participant-detail-id mono">{user.id}</p>
                    <p className="participant-detail-copy">
                      Joined {formatLongDate(user.createdAt)}
                    </p>
                  </article>
                ))}
              </div>

              <section className="modal-section">
                <div className="panel-header">
                  <div>
                    <p className="panel-title">Add people</p>
                    <p className="panel-copy">Only friends can be added here.</p>
                  </div>
                </div>

                {availableFriendsForSelectedThread.length ? (
                  <>
                    <div className="selection-list">
                      {availableFriendsForSelectedThread.map((user) => {
                        const selected = participantsToAdd.includes(user.id);

                        return (
                          <button
                            className={`selection-chip ${selected ? "selection-chip-active" : ""}`}
                            key={user.id}
                            onClick={() =>
                              setParticipantsToAdd((current) =>
                                selected
                                  ? current.filter((id) => id !== user.id)
                                  : [...current, user.id]
                              )
                            }
                            type="button"
                          >
                            <AvatarCircle size="xs" user={user} />
                            <span
                              className="selection-chip-name"
                              style={getUserNameStyle(user)}
                            >
                              {user.username}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="manage-actions">
                      <button
                        className="secondary-button"
                        onClick={() => setParticipantsToAdd([])}
                        type="button"
                      >
                        Clear
                      </button>
                      <button
                        className="primary-button"
                        disabled={participantsToAdd.length === 0}
                        onClick={() => void handleAddParticipants()}
                        type="button"
                      >
                        Add people
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">No more friends to add.</div>
                )}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function decodeThreadAppSnapshot(app: ThreadAppState): {
  error: string | null;
  value: AppJsonValue | null;
} {
  try {
    return {
      error: null,
      value: readThreadAppValue(app.document)
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to load app state.",
      value: null
    };
  }
}

function AppsPane({
  apps,
  collaborativeValue,
  collaborativeValueError,
  onBack,
  onCreateApp,
  onDeleteApp,
  onGenerateSource,
  onOpenApp,
  onSaveApp,
  onValueChange,
  selectedApp
}: {
  apps: ThreadAppState[];
  collaborativeValue: AppJsonValue | null;
  collaborativeValueError: string | null;
  onBack: () => void;
  onCreateApp: () => void;
  onDeleteApp: (appId: string) => void;
  onGenerateSource: (params: {
    prompt: string;
    name: string;
    description: string;
    currentSource: string;
    onDelta: (accumulated: string) => void;
  }) => Promise<{
    source: string;
    model: string;
  }>;
  onOpenApp: (appId: string) => void;
  onSaveApp: (appId: string, nextValues: {
    name: string;
    description: string;
    source: string;
    value: AppJsonValue;
  }) => Promise<void>;
  onValueChange: (appId: string, path: AppPathSegment[], value: AppJsonValue) => void;
  selectedApp: ThreadAppState | null;
}) {
  const [appDetailMode, setAppDetailMode] = useState<AppDetailMode>("view");
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftSource, setDraftSource] = useState(DEFAULT_JSON5_SOURCE);
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationPending, setGenerationPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    setAppDetailMode("view");
    setGenerationPrompt("");
    setGenerationPending(false);
    setFeedback(null);
  }, [selectedApp?.id]);

  useEffect(() => {
    if (!selectedApp || appDetailMode === "edit") {
      return;
    }

    setDraftName(selectedApp.name);
    setDraftDescription(selectedApp.description);
    setDraftSource(selectedApp.savedSource);
  }, [
    appDetailMode,
    selectedApp?.description,
    selectedApp?.id,
    selectedApp?.name,
    selectedApp?.savedSource
  ]);

  if (selectedApp) {
    const currentApp = selectedApp;
    const editing = appDetailMode === "edit";
    const source = editing ? draftSource : currentApp.savedSource;
    const validation = validateJson5Source(source);
    const currentValue = editing
      ? validation.value ?? collaborativeValue ?? {}
      : collaborativeValue ?? validation.value ?? {};
    const title = editing ? draftName : currentApp.name;
    const description = editing ? draftDescription : currentApp.description;

    function handleStartEditing() {
      setDraftName(currentApp.name);
      setDraftDescription(currentApp.description);
      setDraftSource(currentApp.savedSource);
      setGenerationPrompt("");
      setGenerationPending(false);
      setFeedback(null);
      setAppDetailMode("edit");
    }

    function handleDiscardChanges() {
      setDraftName(currentApp.name);
      setDraftDescription(currentApp.description);
      setDraftSource(currentApp.savedSource);
      setGenerationPrompt("");
      setGenerationPending(false);
      setFeedback(null);
      setAppDetailMode("view");
    }

    async function handleSaveChanges() {
      if (validation.error || validation.value === null) {
        setFeedback({
          tone: "error",
          message: validation.error ?? "Invalid JSON5."
        });
        return;
      }

      try {
        await onSaveApp(currentApp.id, {
          name: draftName,
          description: draftDescription,
          source: draftSource,
          value: validation.value
        });
        setFeedback({
          tone: "success",
          message: "Saved."
        });
        setAppDetailMode("view");
      } catch (error) {
        setFeedback({
          tone: "error",
          message: error instanceof Error ? error.message : "Unable to save app."
        });
      }
    }

    async function handleGenerateDraft() {
      const prompt = generationPrompt.trim();
      const previousSource = draftSource;
      let streamedAnyContent = false;

      if (!prompt) {
        setFeedback({
          tone: "error",
          message: "Enter a prompt before calling the LLM."
        });
        return;
      }

      try {
        setGenerationPending(true);
        setFeedback(null);
        setDraftSource("");

        const result = await onGenerateSource({
          prompt,
          name: draftName,
          description: draftDescription,
          currentSource: draftSource,
          onDelta: (accumulated) => {
            streamedAnyContent = true;
            setDraftSource(accumulated);
          }
        });

        setDraftSource(result.source);
        setFeedback({
          tone: "success",
          message: `Draft streamed in from LLM call (${result.model}).`
        });
      } catch (error) {
        if (!streamedAnyContent) {
          setDraftSource(previousSource);
        }
        setFeedback({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to generate app source."
        });
      } finally {
        setGenerationPending(false);
      }
    }

    return (
      <div className="apps-browser">
        <div className="apps-detail-head">
          <button className="ghost-button apps-back-button" onClick={onBack} type="button">
            <RiArrowLeftSLine aria-hidden="true" />
            Back
          </button>

          <div className="apps-detail-copy">
            <h3 className="apps-detail-title">{title || "Untitled app"}</h3>
            {description ? (
              <p className="panel-copy">{description}</p>
            ) : (
              <p className="panel-copy">No description yet.</p>
            )}
            {collaborativeValueError ? (
              <p className="panel-copy app-collab-error">{collaborativeValueError}</p>
            ) : null}
            {feedback ? (
              <p className={`panel-copy app-save-feedback-inline app-save-feedback-${feedback.tone}`}>
                {feedback.message}
              </p>
            ) : null}
          </div>

          <div className="app-detail-actions">
            {editing ? (
              <>
                <button
                  aria-label="Discard local changes"
                  className="ghost-button icon-button app-mode-button"
                  onClick={handleDiscardChanges}
                  title="Discard local changes"
                  type="button"
                >
                  <RiCloseLine aria-hidden="true" />
                </button>
                <button
                  aria-label="Save app"
                  className="primary-button icon-button app-mode-save-button"
                  onClick={() => void handleSaveChanges()}
                  title="Save app"
                  type="button"
                >
                  <RiCheckLine aria-hidden="true" />
                </button>
              </>
            ) : (
              <button
                aria-label="Edit app"
                className="ghost-button icon-button app-mode-button"
                onClick={handleStartEditing}
                title="Edit app"
                type="button"
              >
                <RiPencilLine aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {editing ? (
          <section className="panel app-generator-panel">
            <p className="panel-copy">
              Describe the shape you want. This only updates the local draft
              until you save.
            </p>

            <label className="field">
              <span>Prompt</span>
              <textarea
                onChange={(event) => setGenerationPrompt(event.target.value)}
                placeholder="Generate a signup flow with name, email, role, newsletter opt-in, and a list of interests."
                rows={4}
                value={generationPrompt}
              />
            </label>

            <div className="app-generator-actions">
              <button
                className="ghost-button app-generator-button"
                disabled={generationPending || !generationPrompt.trim()}
                onClick={() => void handleGenerateDraft()}
                type="button"
              >
                {generationPending ? "Streaming..." : "LLM call"}
              </button>
            </div>
          </section>
        ) : null}

        {editing ? (
          <section className="panel app-detail-meta-panel">
            <label className="field">
              <span>Title</span>
              <input
                onChange={(event) => setDraftName(event.target.value)}
                type="text"
                value={draftName}
              />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Add a short description for this app."
                rows={3}
                value={draftDescription}
              />
            </label>
          </section>
        ) : null}

        {editing ? (
          <Json5Workbench
            compact
            onSourceChange={setDraftSource}
            parseError={validation.error}
            source={draftSource}
            sourceHint="Generate into the draft or edit it by hand, then save to publish the new shared shape."
            value={currentValue}
            viewMode="split"
          />
        ) : (
          <JsonValueWorkbench
            onValueChange={(path, value) => onValueChange(currentApp.id, path, value)}
            source={source}
            value={currentValue}
          />
        )}
      </div>
    );
  }

  return (
    <div className="apps-browser">
      <section className="panel apps-list-panel">
        <div className="apps-list-header">
          <div>
            <p className="panel-title">Apps</p>
          </div>

          <button
            aria-label="Create app"
            className="ghost-button icon-button apps-create-button"
            onClick={onCreateApp}
            title="Create app"
            type="button"
          >
            <RiAddLine aria-hidden="true" />
          </button>
        </div>

        {apps.length ? (
          <div className="apps-list">
            {apps.map((app) => (
              <article className="app-card" key={app.id}>
                <button
                  className="app-card-main"
                  onClick={() => onOpenApp(app.id)}
                  type="button"
                >
                  <span className="app-card-name">{app.name}</span>
                  {app.description ? (
                    <span className="app-card-description">{app.description}</span>
                  ) : null}
                </button>

                <div className="app-card-actions">
                  <button
                    aria-label={`Delete ${app.name}`}
                    className="ghost-button icon-button danger-button app-card-delete"
                    onClick={() => onDeleteApp(app.id)}
                    title={`Delete ${app.name}`}
                    type="button"
                  >
                    <RiDeleteBinLine aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">No apps yet. Create one to get started.</div>
        )}
      </section>
    </div>
  );
}

function ParticipantStack({
  participants,
  onOpenModal,
  selfId,
  friendIds
}: {
  participants: UserProfile[];
  onOpenModal: () => void;
  selfId?: string;
  friendIds: Set<string>;
}) {
  const visibleParticipants = participants.slice(0, 4);
  const overflowCount = participants.length - visibleParticipants.length;

  return (
    <div className="participant-stack">
      {visibleParticipants.map((user, index) => (
        <div
          className="participant-stack-item"
          key={user.id}
          style={{ zIndex: visibleParticipants.length - index }}
        >
          <UserHoverAvatar
            friendIds={friendIds}
            selfId={selfId}
            size="sm"
            user={user}
          />
        </div>
      ))}

      <button
        className="participant-more"
        onClick={onOpenModal}
        type="button"
      >
        {overflowCount > 0 ? (
          <span className="participant-more-count">+{overflowCount}</span>
        ) : (
          <RiAddLine aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function ThreadParticipantStrip({
  participants
}: {
  participants: UserProfile[];
}) {
  const visibleParticipants = participants.slice(0, 3);
  const overflowCount = participants.length - visibleParticipants.length;

  return (
    <div className="thread-participant-strip">
      {visibleParticipants.map((user, index) => (
        <span
          className="thread-participant-avatar"
          key={user.id}
          style={{ zIndex: visibleParticipants.length - index }}
        >
          <AvatarCircle size="xs" user={user} />
        </span>
      ))}

      {overflowCount > 0 ? (
        <span className="thread-card-count">+{overflowCount}</span>
      ) : null}
    </div>
  );
}

function UserHoverAvatar({
  user,
  friendIds,
  selfId,
  size,
  align = "start"
}: {
  user: UserProfile;
  friendIds: Set<string>;
  selfId?: string;
  size: AvatarSize;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] =
    useState<UserHoverPopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = useRef<number | null>(null);
  const popoverId = useId();

  function clearCloseTimeout() {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }

  function openPopover() {
    clearCloseTimeout();
    setOpen(true);
  }

  function closePopover() {
    clearCloseTimeout();
    setOpen(false);
  }

  function scheduleClose() {
    clearCloseTimeout();
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null;
      setOpen(false);
    }, 110);
  }

  useEffect(() => {
    return () => {
      clearCloseTimeout();
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }

    const updatePosition = () => {
      const triggerNode = triggerRef.current;
      const popoverNode = popoverRef.current;
      if (!triggerNode || !popoverNode) {
        return;
      }

      const viewportPadding = 12;
      const gap = 10;
      const triggerRect = triggerNode.getBoundingClientRect();
      const popoverRect = popoverNode.getBoundingClientRect();
      if (
        triggerRect.bottom < 0 ||
        triggerRect.right < 0 ||
        triggerRect.left > window.innerWidth ||
        triggerRect.top > window.innerHeight
      ) {
        closePopover();
        return;
      }
      const preferTop =
        window.innerHeight - triggerRect.bottom < popoverRect.height + gap &&
        triggerRect.top > window.innerHeight - triggerRect.bottom;
      const unclampedLeft =
        align === "end"
          ? triggerRect.right - popoverRect.width
          : triggerRect.left;
      const unclampedTop = preferTop
        ? triggerRect.top - popoverRect.height - gap
        : triggerRect.bottom + gap;
      const left = Math.min(
        Math.max(unclampedLeft, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - popoverRect.width - viewportPadding)
      );
      const top = Math.min(
        Math.max(unclampedTop, viewportPadding),
        Math.max(
          viewportPadding,
          window.innerHeight - popoverRect.height - viewportPadding
        )
      );

      setPopoverPosition((current) => {
        const nextPosition = {
          left,
          top,
          placement: preferTop ? "top" : "bottom"
        } satisfies UserHoverPopoverPosition;

        if (
          current &&
          current.left === nextPosition.left &&
          current.top === nextPosition.top &&
          current.placement === nextPosition.placement
        ) {
          return current;
        }

        return nextPosition;
      });
    };

    const animationFrame = window.requestAnimationFrame(updatePosition);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        triggerRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      closePopover();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePopover();
      }
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [align, open]);

  const popoverStyle: CSSProperties = popoverPosition
    ? {
        left: popoverPosition.left,
        top: popoverPosition.top
      }
    : {
        left: 0,
        top: 0,
        visibility: "hidden"
      };

  return (
    <>
      <div className="user-hover-anchor">
        <button
          aria-controls={popoverId}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="avatar-trigger"
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              nextTarget instanceof Node &&
              popoverRef.current?.contains(nextTarget)
            ) {
              return;
            }
            scheduleClose();
          }}
          onFocus={openPopover}
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") {
              openPopover();
            }
          }}
          onPointerEnter={openPopover}
          onPointerLeave={scheduleClose}
          ref={triggerRef}
          type="button"
        >
          <AvatarCircle size={size} user={user} />
        </button>
      </div>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="user-hover-card"
              data-placement={popoverPosition?.placement ?? "bottom"}
              id={popoverId}
              onPointerEnter={openPopover}
              onPointerLeave={scheduleClose}
              ref={popoverRef}
              role="dialog"
              style={popoverStyle}
            >
              <div className="user-hover-head">
                <AvatarCircle size="lg" user={user} />

                <div className="user-hover-info">
                  <p className="user-hover-name" style={getUserNameStyle(user)}>
                    {user.username}
                  </p>

                  <div className="participant-detail-badges">
                    {user.id === selfId ? <span className="agent-pill">you</span> : null}
                    {friendIds.has(user.id) ? (
                      <span className="agent-pill">friend</span>
                    ) : null}
                    <span className="agent-pill">{user.kind}</span>
                  </div>
                </div>
              </div>

              <div className="user-hover-meta">
                <span className="user-hover-id-pill mono" title={user.id}>
                  {formatCompactId(user.id)}
                </span>
                <p className="user-hover-copy">Joined {formatLongDate(user.createdAt)}</p>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function AvatarCircle({
  user,
  size
}: {
  user: Pick<UserProfile, "id" | "avatar">;
  size: AvatarSize;
}) {
  const [imageSource, setImageSource] = useState<string | null>(null);

  useEffect(() => {
    const cssSize = avatarSizePixels[size];
    const pixelRatio =
      typeof window === "undefined" ? 1.5 : Math.min(window.devicePixelRatio || 1, 2);
    const renderSize = Math.ceil(cssSize * pixelRatio * 1.6);
    const nextImageSource = getProceduralAvatarDataUrl({
      avatar: user.avatar,
      seed: user.id,
      size: renderSize
    });

    setImageSource(nextImageSource);
  }, [
    size,
    user.avatar.accent,
    user.avatar.base,
    user.avatar.highlight,
    user.avatar.pattern,
    user.id
  ]);

  return (
    <span
      aria-hidden="true"
      className={`avatar avatar-${size}`}
      style={getAvatarFallbackStyle(user.avatar)}
    >
      {imageSource ? (
        <img
          alt=""
          className="avatar-image"
          draggable={false}
          src={imageSource}
        />
      ) : null}
    </span>
  );
}

function getThreadLabel(
  thread: ChatThread,
  usersById: Map<string, UserProfile>,
  selfId: string
): string {
  const trimmedTitle = thread.title.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  const otherParticipants = thread.participantIds.filter(
    (participantId) => participantId !== selfId
  );
  if (!otherParticipants.length) {
    return "Solo chat";
  }

  return otherParticipants
    .map((participantId) => usersById.get(participantId)?.username ?? "Unknown")
    .join(", ");
}

function getMessagePreview(message: ChatMessage): string {
  return extractMessageText(message);
}

function renderMessage(
  message: ChatMessage,
  options?: {
    appLookup: Map<
      string,
      {
        app: ThreadAppState;
        snapshot: {
          error: string | null;
          value: AppJsonValue | null;
        };
      }
    >;
    onOpenApp: (appId: string) => void;
    onValueChange: (appId: string, path: AppPathSegment[], value: AppJsonValue) => void;
  }
) {
  const embeddedApp = readEmbeddedAppMessage(message);
  if (embeddedApp) {
    const entry = options?.appLookup.get(embeddedApp.appId);

    return (
      <EmbeddedAppMessage
        app={entry?.app ?? null}
        appError={entry?.snapshot.error ?? null}
        appValue={entry?.snapshot.value ?? null}
        fallbackName={embeddedApp.appName}
        onOpenApp={options?.onOpenApp}
        onValueChange={options?.onValueChange}
      />
    );
  }

  const text = typeof message.message.text === "string"
    ? message.message.text
    : null;
  if (text) {
    return <p>{text}</p>;
  }

  return <pre>{JSON.stringify(message.message, null, 2)}</pre>;
}

function EmbeddedAppMessage({
  app,
  appError,
  appValue,
  fallbackName,
  onOpenApp,
  onValueChange
}: {
  app: ThreadAppState | null;
  appError: string | null;
  appValue: AppJsonValue | null;
  fallbackName: string;
  onOpenApp?: (appId: string) => void;
  onValueChange?: (appId: string, path: AppPathSegment[], value: AppJsonValue) => void;
}) {
  const appName = app?.name || fallbackName;
  const description = app?.description?.trim() ?? "";
  const appUnavailable = !app || appError || appValue === null;

  return (
    <div className="message-app-embed">
      <div className="message-app-embed-head">
        <div className="message-app-embed-copy">
          <span className="message-app-embed-eyebrow">Shared app</span>
          <h4 className="message-app-embed-name">{appName}</h4>
          {description ? (
            <p className="message-app-embed-description">{description}</p>
          ) : null}
        </div>

        {app ? (
          <button
            aria-label={`Open ${app.name}`}
            className="ghost-button icon-button message-app-embed-open"
            onClick={() => onOpenApp?.(app.id)}
            title={`Open ${app.name}`}
            type="button"
          >
            <RiApps2Line aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {appUnavailable ? (
        <p className="message-app-embed-note">
          {appError || "This app is no longer available in this chat."}
        </p>
      ) : (
        <JsonRenderSurface
          onValueChange={(path, value) => onValueChange?.(app.id, path, value)}
          source={app.savedSource}
          value={appValue}
          variant="embed"
        />
      )}
    </div>
  );
}

function groupReactions(message: ChatMessage, selfId?: string) {
  const groups = new Map<
    string,
    {
      emoji: string;
      count: number;
      mine: boolean;
    }
  >();

  for (const reaction of message.reactions) {
    const existingGroup = groups.get(reaction.emoji);
    if (existingGroup) {
      existingGroup.count += 1;
      existingGroup.mine = existingGroup.mine || reaction.agentId === selfId;
    } else {
      groups.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        mine: reaction.agentId === selfId
      });
    }
  }

  return [...groups.values()];
}

function getDisplayUser(
  usersById: Map<string, UserProfile>,
  userId: string
): UserProfile {
  return usersById.get(userId) ?? createFallbackUser(userId);
}

function createFallbackUser(
  userId: string,
  username = "Unknown",
  kind: AgentKind = "user"
): UserProfile {
  return {
    id: userId,
    username,
    kind,
    avatar: createProceduralAvatar(userId),
    createdAt: "",
    updatedAt: "",
    profileSummary: null
  };
}

function getUserNameStyle(
  user: Pick<UserProfile, "avatar"> | null | undefined
): CSSProperties {
  return {
    color: user?.avatar.text ?? "var(--text)"
  };
}

function getAvatarFallbackStyle(avatar: ProceduralAvatar): CSSProperties {
  return {
    backgroundColor: "rgba(8, 10, 14, 0.94)",
    backgroundImage: `radial-gradient(circle at 28% 24%, rgba(255, 255, 255, 0.42) 0%, transparent 18%), radial-gradient(circle at 34% 32%, ${avatar.highlight} 0%, ${avatar.highlight} 16%, transparent 42%), radial-gradient(circle at 70% 76%, ${avatar.accent} 0%, transparent 54%), linear-gradient(150deg, ${avatar.base} 0%, ${avatar.accent} 58%, ${avatar.highlight} 100%)`
  };
}

function closeSidebarIfOverlay(
  setSidebarOpen: Dispatch<SetStateAction<boolean>>
) {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 959px)").matches
  ) {
    setSidebarOpen(false);
  }
}

function formatCompactId(value: string): string {
  if (!value) {
    return "...";
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatLongDate(value: string): string {
  if (!value) {
    return "recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

const avatarSizePixels: Record<AvatarSize, number> = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 52
};
