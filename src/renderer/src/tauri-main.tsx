import React from 'react'
import ReactDOM from 'react-dom/client'
import { LocalApp } from './LocalApp'
import { WriteApprovalWindow } from './WriteApprovalWindow'
import './index.css'

const surface = new URLSearchParams(window.location.search).get('surface')
const app = surface === 'write-approval' ? <WriteApprovalWindow /> : <LocalApp />

ReactDOM.createRoot(document.getElementById('root')!).render(app)
