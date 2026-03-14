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
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiChat3Line,
  RiCloseLine,
  RiFileCopyLine,
  RiMenuLine,
  RiSearchLine,
  RiUserAddLine,
  RiUserUnfollowLine
} from "react-icons/ri";

import {
  type AgentKind,
  type ChatMessage,
  type ChatThread,
  type ClientSnapshot,
  type ProceduralAvatar,
  type ThreadSearchResult,
  type UserProfile,
  createProceduralAvatar,
  extractMessageText
} from "@social/shared";

import {
  chatServerUrl,
  searchThreadMessages,
  sendCommand
} from "../lib/chat-api";
import { getProceduralAvatarDataUrl } from "../lib/avatar-renderer";
import {
  getOrCreateProfile,
  type StoredProfile
} from "../lib/profile-store";

const reactionChoices = ["👍", "🔥", "❤️", "😂", "👀"];

type SidebarTab = "threads" | "friends";
type ConnectionState = "connecting" | "online" | "offline";
type AvatarSize = "xs" | "sm" | "md" | "lg";
type UserHoverPopoverPosition = {
  top: number;
  left: number;
  placement: "top" | "bottom";
};

export function ChatApp() {
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("threads");
  const [createTitle, setCreateTitle] = useState("");
  const [selectedFriends, setSelectedFriends] = useState<string[]>([]);
  const [friendSearch, setFriendSearch] = useState("");
  const [participantModalOpen, setParticipantModalOpen] = useState(false);
  const [participantsToAdd, setParticipantsToAdd] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [reactionTargetId, setReactionTargetId] = useState<string | null>(null);
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

  const deferredFriendSearch = useDeferredValue(friendSearch);
  const deferredMessageSearchQuery = useDeferredValue(messageSearchQuery);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
    setParticipantsToAdd([]);
    setReactionTargetId(null);
    setSearchOpen(false);
    setMessageSearchQuery("");
    setSearchResults([]);
    setActiveSearchIndex(0);
    setSearchError(null);
  }, [selectedThreadId]);

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
      setCreateTitle("");
      setSelectedFriends([]);
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

    if (!window.confirm("Delete this chat for everyone?")) {
      return;
    }

    try {
      await sendCommand({
        command: "thread.delete",
        agentId: profile.id,
        threadId
      });
      setParticipantModalOpen(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to delete thread."
      );
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
    } catch (error) {
      setDraft(nextDraft);
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to send message."
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
            <h1>Chats</h1>
            <button
              aria-label="Hide sidebar"
              className="ghost-button icon-button"
              onClick={() => setSidebarOpen(false)}
              type="button"
            >
              <RiArrowLeftSLine aria-hidden="true" />
            </button>
          </div>

          <div className="pill-tabs">
            <button
              className={sidebarTab === "threads" ? "tab-active" : ""}
              onClick={() => setSidebarTab("threads")}
              type="button"
            >
              Threads
            </button>
            <button
              className={sidebarTab === "friends" ? "tab-active" : ""}
              onClick={() => setSidebarTab("friends")}
              type="button"
            >
              People
            </button>
          </div>

          {sidebarTab === "threads" ? (
            <div className="sidebar-section-stack">
              <section className="panel create-chat-panel">
                <div className="panel-header">
                  <p className="panel-title">New chat</p>
                </div>

                <label className="field">
                  <span>Title</span>
                  <input
                    onChange={(event) => setCreateTitle(event.target.value)}
                    placeholder="Optional"
                    value={createTitle}
                  />
                </label>

                <div className="selection-list">
                  {(snapshot?.users ?? [])
                    .filter(
                      (user) => user.id !== profile?.id && friendIds.has(user.id)
                    )
                    .map((user) => {
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

                <div className="create-chat-actions">
                  <button
                    className="primary-button create-chat-button"
                    disabled={selectedFriends.length === 0}
                    onClick={() => void handleCreateThread()}
                    type="button"
                  >
                    Create chat
                  </button>
                </div>
              </section>

              <section className="panel panel-list">
                <div className="panel-header">
                  <p className="panel-title">Recent</p>
                </div>

                <div className="thread-list">
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
                    <div className="empty-state">Start with a friend and open a chat.</div>
                  )}
                </div>
              </section>
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

              <section className="panel directory-panel">
                <div className="panel-header">
                  <p className="panel-title">People</p>
                </div>

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
                  selectedThread && searchOpen ? "conversation-header-search-open" : ""
                }`}
              >
                {selectedThread && searchOpen ? (
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
                            : "Open the sidebar to pick or create a chat."}
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

                      {selectedThread ? (
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
                          onClick={() => void handleDeleteThread(selectedThread.id)}
                          type="button"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </header>

              <div className="conversation-body">
                {selectedThread ? (
                  <>
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
                                {renderMessage(message)}
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
                  </>
                ) : (
                  <div className="blank-state">
                    <div className="blank-card">
                      <h3>No chat selected</h3>
                      <p>Open the sidebar, pick people, and start talking.</p>
                    </div>
                  </div>
                )}

                {selectedThread && showJumpToLatest ? (
                  <button
                    className="jump-button"
                    onClick={() => scrollToLatest("smooth")}
                    type="button"
                  >
                    Latest
                  </button>
                ) : null}
              </div>

              <footer className="composer">
                {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

                <div className="composer-shell">
                  <textarea
                    disabled={!selectedThread}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Send a message"
                    rows={1}
                    value={draft}
                  />
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
            </>
          )}
        </section>
      </section>

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

function renderMessage(message: ChatMessage) {
  const text = typeof message.message.text === "string"
    ? message.message.text
    : null;
  if (text) {
    return <p>{text}</p>;
  }

  return <pre>{JSON.stringify(message.message, null, 2)}</pre>;
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
