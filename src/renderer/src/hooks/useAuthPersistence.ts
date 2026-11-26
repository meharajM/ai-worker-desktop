
import { useEffect } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * Hook to handle Firebase Auth state persistence
 * Ensures the auth listener is initialized exactly once on app mount.
 * Antigravity OAuth session initialization is temporarily disabled.
 */
export function useAuthPersistence() {
    const { initializeAuthListener } = useAuthStore()
    const privacyMode = useSettingsStore((state) => state.privacyMode)

    useEffect(() => {
        if (privacyMode !== 'connected') return

        const initAuth = async () => {
            // initializeAuthListener handles FEATURE_FLAGS check internally
            const unsubscribe = await initializeAuthListener()

            // Antigravity OAuth initialization disabled.

            return unsubscribe
        }

        const unsubscribePromise = initAuth()

        return () => {
            // Cleanup subscription on unmount
            unsubscribePromise.then(unsub => unsub && unsub())
        }
    }, [initializeAuthListener, privacyMode])
}
