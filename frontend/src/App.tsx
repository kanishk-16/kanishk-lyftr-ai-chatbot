import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  RotateCcw, 
  Cpu, 
  Zap, 
  Clock, 
  Hash, 
  Key, 
  ShieldAlert, 
  Settings2, 
  AlertCircle,
  Database,
  CheckCircle2,
  Sparkles
} from 'lucide-react';

interface ChatMetadata {
  resolution_source: 'LIVE_INFERENCE' | 'LLM_CACHE';
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  key_id?: string | null;
  fallback_attempts?: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  metadata?: ChatMetadata;
}

interface HealthData {
  status: string;
  keys_configured: number;
  cache_enabled: boolean;
}

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function generateSessionId(): string {
  return 's-' + Math.random().toString(36).substring(2, 10);
}

export default function App() {
  const [sessionId, setSessionId] = useState<string>(() => generateSessionId());
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check backend health
  const checkHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data: HealthData = await res.json();
      setHealth(data);
      setHealthError(null);
    } catch (err: any) {
      setHealthError(err.message || 'Cannot reach backend');
      setHealth(null);
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll chat messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Start new session
  const handleNewSession = () => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
    if (inputRef.current) inputRef.current.focus();
  };

  // Send message
  const handleSend = async () => {
    const trimmed = inputMessage.trim();
    if (!trimmed || isLoading) return;

    // Reset input immediately per contract: "Empty after sending"
    setInputMessage('');

    const userMsg: Message = {
      id: 'msg-' + Date.now() + '-user',
      role: 'user',
      content: trimmed,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (simulateFailure.trim()) {
        headers['X-Simulate-Failure'] = simulateFailure.trim();
      }

      const body: { session_id: string; message: string; system_prompt?: string } = {
        session_id: sessionId,
        message: trimmed,
      };
      if (systemPrompt.trim()) {
        body.system_prompt = systemPrompt.trim();
      }

      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        // Display readable error message per contract: "Errors (422, 503) show as a readable message in the chat, never a blank screen."
        let errorText = `Error ${res.status}: `;
        if (typeof data.detail === 'string') {
          errorText += data.detail;
        } else if (Array.isArray(data.detail)) {
          errorText += data.detail.map((d: any) => d.msg || JSON.stringify(d)).join(', ');
        } else {
          errorText += JSON.stringify(data.detail || 'An unknown error occurred');
        }

        const errorMsg: Message = {
          id: 'msg-' + Date.now() + '-err',
          role: 'error',
          content: errorText,
        };
        setMessages((prev) => [...prev, errorMsg]);
      } else {
        const assistantMsg: Message = {
          id: 'msg-' + Date.now() + '-assistant',
          role: 'assistant',
          content: data.reply,
          metadata: data.metadata,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (err: any) {
      const errorMsg: Message = {
        id: 'msg-' + Date.now() + '-err',
        role: 'error',
        content: `Connection Error: ${err.message || 'Failed to communicate with backend gateway'}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <header style={{
        padding: '16px 24px',
        borderBottom: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-secondary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
            padding: '8px',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)'
          }}>
            <Sparkles size={22} color="#ffffff" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.025em' }}>
              Lyftr AI <span style={{ fontWeight: 400, color: 'var(--text-secondary)', fontSize: '0.95rem' }}>Gateway Chat</span>
            </h1>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              LLM Chatbot with Key Failover &amp; Response Caching
            </p>
          </div>
        </div>

        {/* Health status & Session Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {health ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '20px',
              backgroundColor: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              fontSize: '0.78rem',
              color: 'var(--accent-cache)'
            }}>
              <CheckCircle2 size={14} />
              <span>Gateway Online</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <span>{health.keys_configured} keys pool</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <span>Cache active</span>
            </div>
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '20px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              fontSize: '0.78rem',
              color: 'var(--danger)'
            }}>
              <AlertCircle size={14} />
              <span>{healthError ? 'Backend Disconnected' : 'Checking Health...'}</span>
            </div>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: 'var(--bg-card)',
            padding: '6px 12px',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            fontSize: '0.8rem'
          }}>
            <Database size={14} color="var(--text-secondary)" />
            <span style={{ color: 'var(--text-secondary)' }}>Session:</span>
            <span className="mono" style={{ fontWeight: 600, color: 'var(--primary)' }}>{sessionId}</span>
            <button
              onClick={handleNewSession}
              title="Start a new session on page load or on click"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                marginLeft: '4px'
              }}
            >
              <RotateCcw size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Control Toolbar: System prompt toggle & Failover simulator */}
      <div style={{
        padding: '10px 24px',
        backgroundColor: 'rgba(17, 24, 39, 0.8)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        fontSize: '0.82rem'
      }}>
        {/* Failover simulation dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldAlert size={16} color="var(--warning)" />
          <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>Failover Hook (X-Simulate-Failure):</span>
          <select
            value={simulateFailure}
            onChange={(e) => setSimulateFailure(e.target.value)}
            style={{
              backgroundColor: 'var(--bg-card)',
              color: simulateFailure ? 'var(--warning)' : 'var(--text-primary)',
              border: simulateFailure ? '1px solid var(--warning)' : '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '0.82rem',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="">None (Standard Execution)</option>
            <option value="key_1=429">key_1=429 (Simulate Rate Limit on Key 1 &rarr; Failover to Key 2)</option>
            <option value="key_1=500">key_1=500 (Simulate Internal Server Error on Key 1 &rarr; Failover to Key 2)</option>
            <option value="key_1=429,key_2=500">key_1=429,key_2=500 (Fail both Key 1 &amp; Key 2)</option>
            <option value="*=429">*=429 (Simulate All Keys Rate-Limited &rarr; HTTP 503)</option>
          </select>
          {simulateFailure && (
            <span style={{ fontSize: '0.72rem', color: 'var(--warning)', padding: '2px 6px', background: 'rgba(245, 158, 11, 0.1)', borderRadius: '4px' }}>
              Simulation Active
            </span>
          )}
        </div>

        {/* System prompt toggle */}
        <button
          onClick={() => setShowSystemPrompt(!showSystemPrompt)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: showSystemPrompt ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
            color: showSystemPrompt ? 'var(--primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: '0.82rem'
          }}
        >
          <Settings2 size={14} />
          <span>System Prompt {systemPrompt ? '(Configured)' : ''}</span>
        </button>
      </div>

      {/* System prompt input drawer */}
      {showSystemPrompt && (
        <div style={{
          padding: '12px 24px',
          backgroundColor: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)'
        }}>
          <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '6px' }}>
            Session System Prompt (optional override)
          </label>
          <input
            data-testid="system-prompt-input"
            type="text"
            placeholder="e.g. You are an expert data scientist who answers with code."
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              backgroundColor: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '0.85rem',
              outline: 'none'
            }}
          />
        </div>
      )}

      {/* Messages Scroll Area */}
      <main style={{
        flex: 1,
        overflowY: 'auto',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {messages.length === 0 ? (
          <div style={{
            margin: 'auto',
            textAlign: 'center',
            maxWidth: '540px',
            padding: '32px',
            background: 'rgba(31, 41, 55, 0.3)',
            borderRadius: '16px',
            border: '1px dashed var(--border-color)'
          }}>
            <div style={{
              width: '52px',
              height: '52px',
              borderRadius: '50%',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px auto'
            }}>
              <Zap size={26} color="var(--primary)" />
            </div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '8px' }}>
              Welcome to the Resilient Chatbot
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '20px' }}>
              Experience automatic key failover on 429/5xx, built-in LiteLLM caching for sub-100ms repeat responses, and real-time per-request token tracking.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Quick Test Prompts (click to try caching):
              </span>
              <button
                onClick={() => setInputMessage('What is the capital of France?')}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.82rem'
                }}
              >
                🇫🇷 &quot;What is the capital of France?&quot;
              </button>
              <button
                onClick={() => setInputMessage('Explain quantum computing in one sentence.')}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '0.82rem'
                }}
              >
                ⚛️ &quot;Explain quantum computing in one sentence.&quot;
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            if (msg.role === 'user') {
              return (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{
                    maxWidth: '75%',
                    backgroundColor: 'var(--primary)',
                    color: '#ffffff',
                    padding: '12px 18px',
                    borderRadius: '16px 16px 4px 16px',
                    fontSize: '0.92rem',
                    lineHeight: 1.5,
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap'
                  }}>
                    {msg.content}
                  </div>
                </div>
              );
            }

            if (msg.role === 'error') {
              return (
                <div key={msg.id} style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{
                    maxWidth: '85%',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#fca5a5',
                    padding: '14px 18px',
                    borderRadius: '16px 16px 16px 4px',
                    fontSize: '0.9rem',
                    lineHeight: 1.5,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '10px'
                  }}>
                    <AlertCircle size={20} color="var(--danger)" style={{ flexShrink: 0, marginTop: '2px' }} />
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: '4px' }}>
                        Request Error
                      </div>
                      <div style={{ wordBreak: 'break-word' }}>{msg.content}</div>
                    </div>
                  </div>
                </div>
              );
            }

            // Assistant reply with exact contract data-testid attributes
            return (
              <div
                key={msg.id}
                data-testid="assistant-message"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignSelf: 'flex-start',
                  maxWidth: '85%',
                  backgroundColor: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '16px 16px 16px 4px',
                  padding: '16px 20px',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
                  gap: '12px'
                }}
              >
                {/* Reply text content */}
                <div style={{
                  fontSize: '0.94rem',
                  lineHeight: 1.6,
                  color: 'var(--text-primary)',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap'
                }}>
                  {msg.content}
                </div>

                {/* Metadata block with required data-testid elements */}
                {msg.metadata && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '8px',
                    paddingTop: '10px',
                    borderTop: '1px solid rgba(255, 255, 255, 0.07)',
                    fontSize: '0.76rem'
                  }}>
                    {/* Resolution source badge: LIVE_INFERENCE or LLM_CACHE */}
                    <div
                      data-testid="meta-source"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '6px',
                        fontWeight: 600,
                        backgroundColor: msg.metadata.resolution_source === 'LLM_CACHE'
                          ? 'rgba(16, 185, 129, 0.15)'
                          : 'rgba(139, 92, 246, 0.15)',
                        color: msg.metadata.resolution_source === 'LLM_CACHE'
                          ? 'var(--accent-cache)'
                          : 'var(--accent-live)',
                        border: msg.metadata.resolution_source === 'LLM_CACHE'
                          ? '1px solid rgba(16, 185, 129, 0.3)'
                          : '1px solid rgba(139, 92, 246, 0.3)'
                      }}
                    >
                      {msg.metadata.resolution_source === 'LLM_CACHE' ? (
                        <>
                          <Zap size={12} />
                          LLM_CACHE
                        </>
                      ) : (
                        <>
                          <Cpu size={12} />
                          LIVE_INFERENCE
                        </>
                      )}
                    </div>

                    {/* Model badge */}
                    <div
                      data-testid="meta-model"
                      className="mono"
                      style={{
                        padding: '3px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      {msg.metadata.model}
                    </div>

                    {/* Latency badge */}
                    <div
                      data-testid="meta-latency"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      <Clock size={12} />
                      {msg.metadata.latency_ms} ms
                    </div>

                    {/* Input Tokens */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      <Hash size={12} />
                      <span>in: </span>
                      <span data-testid="meta-input-tokens" className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {msg.metadata.input_tokens}
                      </span>
                    </div>

                    {/* Output Tokens */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '3px 8px',
                        borderRadius: '6px',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)'
                      }}
                    >
                      <span>out: </span>
                      <span data-testid="meta-output-tokens" className="mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {msg.metadata.output_tokens}
                      </span>
                    </div>

                    {/* Key ID & Fallback attempts info */}
                    {msg.metadata.key_id && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '3px 8px',
                          borderRadius: '6px',
                          backgroundColor: 'rgba(59, 130, 246, 0.1)',
                          border: '1px solid rgba(59, 130, 246, 0.25)',
                          color: 'var(--primary)'
                        }}
                      >
                        <Key size={12} />
                        <span>{msg.metadata.key_id}</span>
                        {(msg.metadata.fallback_attempts || 0) > 0 && (
                          <span style={{ color: 'var(--warning)', fontWeight: 600 }}>
                            ({msg.metadata.fallback_attempts} fallback{msg.metadata.fallback_attempts! > 1 ? 's' : ''})
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {isLoading && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            alignSelf: 'flex-start',
            padding: '12px 18px',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: '16px 16px 16px 4px',
            color: 'var(--text-secondary)',
            fontSize: '0.85rem'
          }}>
            <div style={{
              width: '14px',
              height: '14px',
              border: '2px solid var(--primary)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }} />
            <span>Generating response...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Input Form Bar */}
      <footer style={{
        padding: '16px 24px',
        borderTop: '1px solid var(--border-color)',
        backgroundColor: 'var(--bg-secondary)'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '12px',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          padding: '8px 12px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
        }}>
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            rows={1}
            placeholder="Type your message... (Enter to send, Shift+Enter for newline)"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            style={{
              flex: 1,
              backgroundColor: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              fontSize: '0.94rem',
              resize: 'none',
              maxHeight: '120px',
              minHeight: '24px',
              padding: '4px 0'
            }}
          />
          <button
            data-testid="send-button"
            onClick={handleSend}
            disabled={!inputMessage.trim() || isLoading}
            style={{
              background: !inputMessage.trim() || isLoading ? 'var(--bg-hover)' : 'var(--primary)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: !inputMessage.trim() || isLoading ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.15s ease',
              flexShrink: 0
            }}
          >
            <Send size={16} />
          </button>
        </div>
      </footer>

      {/* Simple spinner keyframe */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
