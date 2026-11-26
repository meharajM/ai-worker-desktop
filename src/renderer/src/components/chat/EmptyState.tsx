import React from 'react'
import { WorkflowTiles } from '../WorkflowTiles'
import { useWhatsAppStore } from '../../stores/whatsappStore'
import { MessageCircle, Loader2 } from 'lucide-react'
import { StatusBadge } from '../primitives/StatusDot'
import { useSettingsStore } from '../../stores/settingsStore'

interface EmptyStateProps {
  llmReady: boolean
  onOpenSettings?: () => void
}

/**
 * Co-Worker Hub Welcome Screen
 */
export function EmptyState({ llmReady, onOpenSettings }: EmptyStateProps) {
  const { connectionState, openDialog, whatsappEnabled, setWhatsAppEnabled } = useWhatsAppStore()
  const connectedMode = useSettingsStore((state) => state.privacyMode === 'connected')
  const isConnected = connectionState.status === 'connected'
  const isConnecting = connectionState.status === 'connecting'

  const handleWhatsAppClick = () => {
    if (isConnecting) return // Prevent clicks while connecting

    if (isConnected) {
      setWhatsAppEnabled(!whatsappEnabled)
    } else {
      openDialog()
    }
  }

  // Fix stale state: if we're not connected but whatsappEnabled is true, reset it
  React.useEffect(() => {
    if (!isConnected && whatsappEnabled) {
      setWhatsAppEnabled(false)
    }
  }, [isConnected, whatsappEnabled, setWhatsAppEnabled])

  return (
    <div className="flex flex-col items-center justify-center min-h-full max-w-4xl mx-auto w-full pt-8 pb-32">

      {/* System Active Badge */}
      <div className="mb-8">
        <StatusBadge
          variant={llmReady ? 'active' : 'warning'}
          label={llmReady ? 'Model ready' : 'Model setup needed'}
          animated={llmReady}
        />
      </div>

      {/* Greeting */}
      <div className="text-center mb-6">
        <h1 className="text-[var(--text-4xl)] md:text-[var(--text-3xl)] font-[var(--font-weight-bold)] tracking-tight text-[var(--color-text-primary)] mb-2">
          Hey!
        </h1>
        <h2 className="text-[var(--text-4xl)] md:text-[var(--text-3xl)] font-[var(--font-weight-bold)] tracking-tight text-[var(--color-text-primary)]">
          What's on your mind?
        </h2>
      </div>

      {/* Subtitle */}
      <p className="text-[var(--color-text-secondary)] text-[var(--text-base)] text-center max-w-2xl mb-8">
        {llmReady
          ? <>Your Co-Worker is ready. Delegate tasks across connected systems right here or press <span className="font-[var(--font-family-mono)] bg-[var(--color-surface)] px-1 py-0.5 rounded text-[var(--color-text-primary)] text-[var(--text-sm)]">Cmd+K</span> to quickly search.</>
          : <>AI-Worker needs a model before it can answer. Configure Ollama or download and load an on-device model in Settings. Local-only chat stays on this device.</>}
      </p>

      {!llmReady && onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mb-8 rounded-lg bg-[var(--color-brand-teal)] px-4 py-2 text-sm font-medium text-[var(--color-bg-dark)] hover:bg-[var(--color-brand-teal-hover)]"
        >
          Open model settings
        </button>
      )}

      {/* Agent Cards Grid */}
      <div className="w-full">
        <WorkflowTiles />
      </div>

      {/* WhatsApp CTA */}
      {connectedMode && <div className="mt-8 w-full max-w-sm">
        <button
          id="empty-state-whatsapp-btn"
          onClick={handleWhatsAppClick}
          disabled={isConnecting}
          className={`
            w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all group
            ${isConnecting ? 'opacity-50 cursor-wait' : ''}
            ${isConnected
              ? 'border-[#25D366]/40 bg-[#25D366]/5 hover:bg-[#25D366]/10'
              : 'border-white/10 bg-white/3 hover:bg-white/5 hover:border-white/20'
            }
          `}
        >
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isConnected ? 'bg-[#25D366]/20' : 'bg-white/5'
            }`}>
            {isConnecting ? (
              <Loader2 size={16} className="text-white/50 animate-spin" />
            ) : (
              <MessageCircle
                size={16}
                className={isConnected ? 'text-[#25D366]' : 'text-white/30 group-hover:text-white/50 transition-colors'}
              />
            )}
          </div>
          <div className="text-left">
            <p className={`text-sm font-medium ${isConnected ? 'text-[#25D366]' : 'text-white/60 group-hover:text-white/80 transition-colors'
              }`}>
              {isConnecting
                ? 'Connecting...'
                : isConnected
                  ? whatsappEnabled ? 'WhatsApp Mode Active' : 'Enable WhatsApp Mode'
                  : 'Connect WhatsApp'}
            </p>
            <p className="text-xs text-white/30 mt-0.5">
              {isConnecting
                ? 'Please wait...'
                : isConnected
                  ? 'Remote control your AI Worker via WhatsApp'
                  : 'Get AI responses directly on your phone'}
            </p>
          </div>
          {isConnected && (
            <span className="ml-auto w-2 h-2 rounded-full bg-[#25D366] animate-pulse flex-shrink-0" />
          )}
        </button>
      </div>}

    </div>
  )
}
