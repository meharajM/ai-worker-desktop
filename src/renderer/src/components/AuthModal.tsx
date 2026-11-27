import React, { useState } from 'react'
import { X, Mail, Lock, User, AlertCircle, Loader2 } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { AnimatePresence, motion } from 'framer-motion'

interface AuthModalProps {
    isOpen: boolean
    onClose: () => void
}

export function AuthModal({ isOpen, onClose }: AuthModalProps) {
    const [mode, setMode] = useState<'signin' | 'signup'>('signin')
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [name, setName] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [localError, setLocalError] = useState<string | null>(null)

    const {
        signInWithEmail, signUpWithEmail,
        loading, error: storeError
    } = useAuthStore()

    // Reset state when mode changes
    React.useEffect(() => {
        setLocalError(null)
        // usage: clean up errors when switching modes
    }, [mode])

    if (!isOpen) return null

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLocalError(null)

        try {
            if (mode === 'signup') {
                if (password !== confirmPassword) {
                    setLocalError("Passwords don't match")
                    return
                }
                if (password.length < 6) {
                    setLocalError("Password must be at least 6 characters")
                    return
                }
                await signUpWithEmail(email, password, name)
            } else {
                await signInWithEmail(email, password)
            }
            onClose()
        } catch (err) {
            // Error is handled by store but we can catch it here if we want local handling
            // Store error might be more detailed from Firebase
        }
    }

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="w-full max-w-md bg-[var(--color-card-elevated)] border border-[var(--color-border)] rounded-2xl shadow-glass overflow-hidden"
                >
                    {/* Header */}
                    <div className="relative p-6 border-b border-[var(--color-border)] bg-gradient-to-r from-[var(--color-brand-teal)]/5 to-transparent">
                        <button
                            onClick={onClose}
                            className="absolute top-4 right-4 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">
                            {mode === 'signin' ? 'Welcome Back' : 'Create Account'}
                        </h2>
                        <p className="text-sm text-[var(--color-text-muted)] mt-1">
                            {mode === 'signin'
                                ? 'Sign in to sync your preferences across devices'
                                : 'Join AI-Worker to customize your experience'
                            }
                        </p>
                    </div>

                    <div className="p-6 space-y-6">
                        {/* Store/Local Error */}
                        {(storeError || localError) && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2"
                            >
                                <AlertCircle size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
                                <span className="text-xs text-red-400">{localError || storeError}</span>
                            </motion.div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-4">
                            {mode === 'signup' && (
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-[var(--color-text-muted)] ml-1">Full Name</label>
                                    <div className="relative group">
                                        <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)] group-focus-within:text-[var(--color-brand-teal)] transition-colors" />
                                        <input
                                            type="text"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            placeholder="John Doe"
                                            className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-xl py-2.5 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-brand-teal)]/50 focus:bg-[var(--color-surface)] transition-all"
                                            required
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="space-y-1">
                                <label className="text-xs font-medium text-[var(--color-text-muted)] ml-1">Email Address</label>
                                <div className="relative group">
                                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)] group-focus-within:text-[var(--color-brand-teal)] transition-colors" />
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        placeholder="you@example.com"
                                        className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-xl py-2.5 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-brand-teal)]/50 focus:bg-[var(--color-surface)] transition-all"
                                        required
                                    />
                                </div>
                            </div>

                            <div className="space-y-1">
                                <label className="text-xs font-medium text-[var(--color-text-muted)] ml-1">Password</label>
                                <div className="relative group">
                                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)] group-focus-within:text-[var(--color-brand-teal)] transition-colors" />
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-xl py-2.5 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-brand-teal)]/50 focus:bg-[var(--color-surface)] transition-all"
                                        required
                                        minLength={6}
                                    />
                                </div>
                            </div>

                            {mode === 'signup' && (
                                <div className="space-y-1">
                                    <label className="text-xs font-medium text-[var(--color-text-muted)] ml-1">Confirm Password</label>
                                    <div className="relative group">
                                        <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-dim)] group-focus-within:text-[var(--color-brand-teal)] transition-colors" />
                                        <input
                                            type="password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            placeholder="••••••••"
                                            className="w-full bg-[var(--color-input-bg)] border border-[var(--color-border)] rounded-xl py-2.5 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-brand-teal)]/50 focus:bg-[var(--color-surface)] transition-all"
                                            required
                                            minLength={6}
                                        />
                                    </div>
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full py-2.5 bg-gradient-to-r from-[var(--color-brand-teal)] to-[var(--color-success)] text-[var(--color-bg-dark)] font-medium rounded-xl hover:shadow-lg hover:shadow-[var(--color-brand-teal)]/20 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                            >
                                {loading && <Loader2 size={16} className="animate-spin" />}
                                {mode === 'signin' ? 'Sign In' : 'Create Account'}
                            </button>
                        </form>

                        <p className="text-center text-xs text-[var(--color-text-muted)]">
                            Google sign-in is unavailable in this secure desktop build. Use email sign-in instead.
                        </p>

                        <div className="text-center text-sm">
                            <span className="text-[var(--color-text-muted)]">
                                {mode === 'signin' ? "Don't have an account?" : "Already have an account?"}
                            </span>
                            <button
                                onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
                                className="ml-2 text-[var(--color-brand-teal)] hover:text-[var(--color-brand-teal)]/80 font-medium transition-colors"
                            >
                                {mode === 'signin' ? 'Sign Up' : 'Sign In'}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    )
}
