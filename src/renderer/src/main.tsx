import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
if (new URLSearchParams(window.location.search).get('window') === 'task') {
    void import('./task').then(({ TaskWindow }) => {
        root.render(<React.StrictMode><TaskWindow /></React.StrictMode>)
    })
} else {
    void import('./App').then(({ default: App }) => {
        root.render(<React.StrictMode><App /></React.StrictMode>)
    })
}
