// Firebase Initialization & Configuration
import { FEATURE_FLAGS } from '../constants'
import type { FirebaseApp } from 'firebase/app'
import type { Auth, User, UserCredential } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'

export type { User, UserCredential, Auth, FirebaseApp, Firestore }

// Config
export const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'placeholder-api-key',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'placeholder-project',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'placeholder.appspot.com',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:placeholder',
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-XXXXXXXXXX',
}

export const isFirebaseConfigured = (): boolean => {
    return (
        FEATURE_FLAGS.AUTH_ENABLED &&
        firebaseConfig.apiKey !== 'placeholder-api-key' &&
        !!import.meta.env.VITE_FIREBASE_API_KEY
    )
}

// Singletons
let firebaseApp: FirebaseApp | null = null
let firebaseAuth: Auth | null = null
let firebaseFirestore: Firestore | null = null
let firebaseEnabled = false
let firebaseGeneration = 0

export function setFirebaseEnabled(enabled: boolean): void {
    if (firebaseEnabled === enabled) return
    firebaseEnabled = enabled
    firebaseGeneration++

    if (!firebaseModules) return
    if (enabled && firebaseFirestore) {
        void firebaseModules.enableNetwork?.(firebaseFirestore).catch((error) => {
            console.warn('[Privacy] Could not resume connected Firestore:', error)
        })
    } else if (!enabled) {
        if (firebaseAuth) {
            void firebaseModules.signOut(firebaseAuth).catch((error) => {
                console.warn('[Privacy] Could not clear the Firebase session:', error)
            })
        }
        if (firebaseFirestore) {
            void firebaseModules.disableNetwork?.(firebaseFirestore).catch((error) => {
                console.warn('[Privacy] Could not disable Firestore network:', error)
            })
        }
    }
}

// Module references (exported for other modules to use)
export let firebaseModules: {
    initializeApp: typeof import('firebase/app').initializeApp
    getAuth: typeof import('firebase/auth').getAuth
    GoogleAuthProvider: typeof import('firebase/auth').GoogleAuthProvider
    signInWithPopup: typeof import('firebase/auth').signInWithPopup
    signInWithCredential: typeof import('firebase/auth').signInWithCredential
    OAuthCredential: typeof import('firebase/auth').OAuthCredential
    signOut: typeof import('firebase/auth').signOut
    onAuthStateChanged: typeof import('firebase/auth').onAuthStateChanged
    browserPopupRedirectResolver: typeof import('firebase/auth').browserPopupRedirectResolver
    createUserWithEmailAndPassword: typeof import('firebase/auth').createUserWithEmailAndPassword
    signInWithEmailAndPassword: typeof import('firebase/auth').signInWithEmailAndPassword
    updateProfile: typeof import('firebase/auth').updateProfile
    getFirestore: typeof import('firebase/firestore').getFirestore
    doc: typeof import('firebase/firestore').doc
    setDoc: typeof import('firebase/firestore').setDoc
    getDoc: typeof import('firebase/firestore').getDoc
    enableNetwork?: typeof import('firebase/firestore').enableNetwork
    disableNetwork?: typeof import('firebase/firestore').disableNetwork
} | null = null

export async function initializeFirebase(): Promise<{
    app: FirebaseApp
    auth: Auth
    firestore: Firestore
} | null> {
    if (!firebaseEnabled) return null
    const generation = firebaseGeneration

    if (!FEATURE_FLAGS.AUTH_ENABLED) {
        console.log('Firebase auth is disabled via feature flag')
        return null
    }

    if (!isFirebaseConfigured()) {
        console.warn('Firebase is not configured. Set VITE_FIREBASE_* environment variables.')
        return null
    }

    if (firebaseApp && firebaseAuth && firebaseFirestore) {
        return { app: firebaseApp, auth: firebaseAuth, firestore: firebaseFirestore }
    }

    try {
        const [firebaseAppModule, firebaseAuthModule, firebaseFirestoreModule] = await Promise.all([
            import('firebase/app'),
            import('firebase/auth'),
            import('firebase/firestore'),
        ])

        if (!firebaseEnabled || generation !== firebaseGeneration) return null

        firebaseModules = {
            initializeApp: firebaseAppModule.initializeApp,
            getAuth: firebaseAuthModule.getAuth,
            GoogleAuthProvider: firebaseAuthModule.GoogleAuthProvider,
            signInWithPopup: firebaseAuthModule.signInWithPopup,
            signInWithCredential: firebaseAuthModule.signInWithCredential,
            OAuthCredential: firebaseAuthModule.OAuthCredential,
            signOut: firebaseAuthModule.signOut,
            onAuthStateChanged: firebaseAuthModule.onAuthStateChanged,
            browserPopupRedirectResolver: firebaseAuthModule.browserPopupRedirectResolver,
            createUserWithEmailAndPassword: firebaseAuthModule.createUserWithEmailAndPassword,
            signInWithEmailAndPassword: firebaseAuthModule.signInWithEmailAndPassword,
            updateProfile: firebaseAuthModule.updateProfile,
            getFirestore: firebaseFirestoreModule.getFirestore,
            doc: firebaseFirestoreModule.doc,
            setDoc: firebaseFirestoreModule.setDoc,
            getDoc: firebaseFirestoreModule.getDoc,
            enableNetwork: firebaseFirestoreModule.enableNetwork,
            disableNetwork: firebaseFirestoreModule.disableNetwork,
        }

        firebaseApp = firebaseModules.initializeApp(firebaseConfig)
        firebaseAuth = firebaseModules.getAuth(firebaseApp)
        firebaseFirestore = firebaseModules.getFirestore(firebaseApp)

        try {
            const { indexedDBLocalPersistence, setPersistence } = await import('firebase/auth')
            await setPersistence(firebaseAuth, indexedDBLocalPersistence)
            console.log('Firebase auth persistence set to indexedDBLocalPersistence')
        } catch (persistenceError) {
            console.error('Failed to set auth persistence:', persistenceError)
        }

        if (!firebaseEnabled || generation !== firebaseGeneration) {
            await Promise.allSettled([
                firebaseModules.signOut(firebaseAuth),
                firebaseModules.disableNetwork?.(firebaseFirestore),
            ])
            return null
        }

        console.log('Firebase initialized successfully')
        return { app: firebaseApp, auth: firebaseAuth, firestore: firebaseFirestore }
    } catch (error) {
        console.error('Failed to initialize Firebase:', error)
        return null
    }
}
