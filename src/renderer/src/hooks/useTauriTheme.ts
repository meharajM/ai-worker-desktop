import { useEffect, useState } from 'react'
import { desktopBridge, type DesktopPreferences } from '../desktop-bridge'

type ThemePreference = DesktopPreferences['theme']

/** Apply the shared Tauri theme; an override lets Settings preview a pending choice. */
export function useTauriTheme(override?: ThemePreference): void {
  const [storedTheme, setStoredTheme] = useState<ThemePreference>('dark')

  useEffect(() => {
    if (override !== undefined || !desktopBridge.isAvailable()) return
    let current = true
    void desktopBridge.getPreferences().then((result) => {
      if (current) setStoredTheme(result.preferences.theme)
    }).catch(() => {
      // Keep the safe dark default if native preferences cannot be read.
    })
    return () => { current = false }
  }, [override])

  const theme = override ?? storedTheme
  useEffect(() => {
    const root = document.documentElement
    if (theme !== 'system') {
      root.setAttribute('data-theme', theme)
      return
    }
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = () => root.setAttribute('data-theme', colorScheme.matches ? 'dark' : 'light')
    applySystemTheme()
    colorScheme.addEventListener('change', applySystemTheme)
    return () => colorScheme.removeEventListener('change', applySystemTheme)
  }, [theme])
}
