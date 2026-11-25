import { useCallback, useEffect, useRef, useState } from 'react';

interface WorkspaceMembership {
  id: string;
  role: string;
}

interface User {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceMembership[];
}

interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastActivityAt: string;
}

interface ThreadMessage {
  direction: 'inbound' | 'outbound';
  id: string;
  client_ref?: string;
  text: string;
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
  timestamp: string;
}

interface WsFrame {
  seq: number;
  type: string;
  workspace: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: 'queued' | 'sent' | 'delivered' | 'failed' | 'open' | 'closed';
  assignee?: string | null;
  text?: string;
  occurred_at?: string;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [replyText, setReplyText] = useState('');
  const [sending, setSending] = useState(false);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [error, setError] = useState<string | null>(null);

  const lastSeqRef = useRef<number | null>(null);
  const selectedContactRef = useRef<string | null>(null);
  selectedContactRef.current = selectedContact;

  useEffect(() => {
    fetch('/api/me')
      .then(async (res) => {
        if (!res.ok) {
          setUser(null);
          return;
        }
        const me = (await res.json()) as User;
        setUser(me);
        if (me.workspaces.length > 0) {
          setWorkspace(me.workspaces[0].id);
        }
      })
      .catch(() => setUser(null));
  }, []);

  const loadConversations = useCallback(
    async (ws: string, cursor?: string | null) => {
      const params = new URLSearchParams({ workspace: ws, limit: '25' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/conversations?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        conversations: Conversation[];
        nextCursor: string | null;
      };
      if (cursor) {
        setConversations((prev) => [...prev, ...data.conversations]);
      } else {
        setConversations(data.conversations);
      }
      setNextCursor(data.nextCursor);
    },
    [],
  );

  const loadMessages = useCallback(async (ws: string, contact: string) => {
    const params = new URLSearchParams({ workspace: ws });
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(contact)}/messages?${params.toString()}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as { messages: ThreadMessage[] };
    setMessages(data.messages);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    setSelectedContact(null);
    setMessages([]);
    lastSeqRef.current = null;
    void loadConversations(workspace);
  }, [workspace, loadConversations]);

  useEffect(() => {
    if (!workspace || !selectedContact) return;
    void loadMessages(workspace, selectedContact);
  }, [workspace, selectedContact, loadMessages]);

  useEffect(() => {
    if (!workspace) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      setWsStatus(lastSeqRef.current === null ? 'connecting' : 'reconnecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({ workspace });
      if (lastSeqRef.current !== null) {
        qs.set('after', String(lastSeqRef.current));
      }
      socket = new WebSocket(`${proto}//${window.location.host}/ws?${qs.toString()}`);

      socket.onopen = () => {
        setWsStatus('live');
      };

      socket.onmessage = (evt) => {
        try {
          const frame = JSON.parse(String(evt.data)) as WsFrame;
          if (typeof frame.seq === 'number') {
            lastSeqRef.current = Math.max(lastSeqRef.current ?? 0, frame.seq);
          }

          if (frame.type === 'message.inbound' && frame.contact) {
            const ts = frame.occurred_at || new Date().toISOString();
            setConversations((prev) => {
              const existing = prev.find((c) => c.contact === frame.contact);
              const updated: Conversation = existing
                ? { ...existing, lastActivityAt: ts }
                : {
                    workspace,
                    contact: frame.contact!,
                    assignee: null,
                    status: 'open',
                    lastActivityAt: ts,
                  };
              return [updated, ...prev.filter((c) => c.contact !== frame.contact)];
            });

            if (selectedContactRef.current === frame.contact && frame.message_id) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === frame.message_id)) return prev;
                return [
                  ...prev,
                  {
                    direction: 'inbound',
                    id: frame.message_id!,
                    text: frame.text || '',
                    timestamp: ts,
                  },
                ];
              });
            }
          } else if (frame.type === 'message.status' && frame.client_ref && frame.status) {
            if (selectedContactRef.current === frame.contact) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.direction === 'outbound' && m.client_ref === frame.client_ref
                    ? { ...m, status: frame.status as ThreadMessage['status'] }
                    : m,
                ),
              );
            }
          } else if (frame.type === 'conversation.assigned' && frame.contact) {
            setConversations((prev) =>
              prev.map((c) =>
                c.contact === frame.contact ? { ...c, assignee: frame.assignee ?? null } : c,
              ),
            );
          } else if (frame.type === 'conversation.status' && frame.contact && frame.status) {
            setConversations((prev) =>
              prev.map((c) =>
                c.contact === frame.contact
                  ? { ...c, status: frame.status as 'open' | 'closed' }
                  : c,
              ),
            );
          }
        } catch {
          // ignore malformed frame
        }
      };

      socket.onclose = () => {
        if (!closed) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [workspace]);

  const handleClaim = async () => {
    if (!workspace || !selectedContact) return;
    setError(null);
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/claim?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST' },
    );
    if (res.status === 409) {
      setError('Conversation is already claimed by another agent.');
      await loadConversations(workspace);
      return;
    }
    if (res.ok && user) {
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? { ...c, assignee: user.sub } : c)),
      );
    }
  };

  const handleToggleStatus = async (nextStatus: 'open' | 'closed') => {
    if (!workspace || !selectedContact) return;
    setError(null);
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(selectedContact)}/status?workspace=${encodeURIComponent(workspace)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      },
    );
    if (res.ok) {
      setConversations((prev) =>
        prev.map((c) => (c.contact === selectedContact ? { ...c, status: nextStatus } : c)),
      );
    }
  };

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !selectedContact || !replyText.trim() || sending) return;
    setSending(true);
    setError(null);
    const text = replyText.trim();
    const clientRef = crypto.randomUUID();

    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(selectedContact)}/reply?workspace=${encodeURIComponent(workspace)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, client_ref: clientRef }),
        },
      );
      if (!res.ok) {
        setError(`Failed to send (${res.status})`);
        return;
      }
      setReplyText('');
      setMessages((prev) => [
        ...prev,
        {
          direction: 'outbound',
          id: clientRef,
          client_ref: clientRef,
          text,
          status: 'queued',
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    setUser(null);
  };

  if (user === undefined) {
    return (
      <main style={{ font: '15px system-ui', maxWidth: 480, margin: '80px auto', padding: 24 }}>
        <p>Loading Switchboard...</p>
      </main>
    );
  }

  if (user === null) {
    const loginHref = `/auth/login?returnTo=${encodeURIComponent(window.location.origin)}`;
    return (
      <main
        style={{
          font: '15px system-ui',
          maxWidth: 420,
          margin: '100px auto',
          padding: 32,
          border: '1px solid #e2e8f0',
          borderRadius: 10,
        }}
      >
        <h1 style={{ marginTop: 0 }}>Switchboard</h1>
        <p style={{ color: '#475569' }}>Sign in with your workspace account to open the shared inbox.</p>
        <a
          href={loginHref}
          style={{
            display: 'inline-block',
            background: '#0f172a',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 6,
            textDecoration: 'none',
            fontWeight: 600,
          }}
        >
          Sign in with OIDC
        </a>
      </main>
    );
  }

  const activeConv = conversations.find((c) => c.contact === selectedContact) ?? null;

  return (
    <div style={{ font: '14px system-ui', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid #e2e8f0',
          background: '#f8fafc',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <strong>Switchboard</strong>
          <select
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #cbd5e1' }}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
          <span
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 999,
              background: wsStatus === 'live' ? '#dcfce7' : '#fef9c3',
              color: wsStatus === 'live' ? '#166534' : '#854d0e',
            }}
          >
            {wsStatus}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#475569' }}>{user.name || user.sub}</span>
          <button onClick={handleLogout} style={{ padding: '4px 10px', cursor: 'pointer' }}>
            Sign out
          </button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <aside
          style={{
            width: 300,
            borderRight: '1px solid #e2e8f0',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {conversations.length === 0 ? (
            <p style={{ padding: 16, color: '#64748b' }}>No conversations yet.</p>
          ) : (
            conversations.map((c) => {
              const isSelected = c.contact === selectedContact;
              return (
                <button
                  key={c.contact}
                  onClick={() => setSelectedContact(c.contact)}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    border: 'none',
                    borderBottom: '1px solid #f1f5f9',
                    background: isSelected ? '#e0f2fe' : '#fff',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <strong>{c.contact}</strong>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: c.status === 'open' ? '#dbeafe' : '#e2e8f0',
                      }}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {c.assignee ? `Assigned: ${c.assignee}` : 'Unassigned'}
                  </div>
                </button>
              );
            })
          )}
          {nextCursor && (
            <button
              onClick={() => void loadConversations(workspace, nextCursor)}
              style={{ margin: 12, padding: '8px 12px', cursor: 'pointer' }}
            >
              Load more
            </button>
          )}
        </aside>

        <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!selectedContact ? (
            <div style={{ padding: 32, color: '#64748b' }}>
              Select a conversation from the left to view messages and reply.
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #e2e8f0',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <strong>{selectedContact}</strong>
                  <span style={{ marginLeft: 12, fontSize: 12, color: '#64748b' }}>
                    {activeConv?.assignee ? `Held by ${activeConv.assignee}` : 'Unassigned'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={handleClaim}
                    disabled={activeConv?.assignee === user.sub}
                    style={{ padding: '6px 12px', cursor: 'pointer' }}
                  >
                    {activeConv?.assignee === user.sub ? 'Claimed' : 'Claim'}
                  </button>
                  <button
                    onClick={() =>
                      void handleToggleStatus(activeConv?.status === 'closed' ? 'open' : 'closed')
                    }
                    style={{ padding: '6px 12px', cursor: 'pointer' }}
                  >
                    {activeConv?.status === 'closed' ? 'Reopen' : 'Close'}
                  </button>
                </div>
              </div>

              {error && (
                <div style={{ padding: '8px 16px', background: '#fee2e2', color: '#991b1b' }}>
                  {error}
                </div>
              )}

              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {messages.map((m) => {
                  const isOutbound = m.direction === 'outbound';
                  return (
                    <div
                      key={`${m.direction}-${m.id}`}
                      style={{
                        alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                        maxWidth: '70%',
                        padding: '8px 12px',
                        borderRadius: 10,
                        background: isOutbound ? '#0f172a' : '#f1f5f9',
                        color: isOutbound ? '#fff' : '#0f172a',
                      }}
                    >
                      <div>{m.text}</div>
                      <div
                        style={{
                          fontSize: 11,
                          marginTop: 4,
                          opacity: 0.75,
                          display: 'flex',
                          gap: 8,
                          justifyContent: 'flex-end',
                        }}
                      >
                        <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                        {isOutbound && m.status && <span>[{m.status}]</span>}
                      </div>
                    </div>
                  );
                })}
              </div>

              <form
                onSubmit={handleSendReply}
                style={{
                  padding: 12,
                  borderTop: '1px solid #e2e8f0',
                  display: 'flex',
                  gap: 8,
                }}
              >
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Type a reply..."
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #cbd5e1',
                  }}
                />
                <button
                  type="submit"
                  disabled={sending || !replyText.trim()}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    background: '#0f172a',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
