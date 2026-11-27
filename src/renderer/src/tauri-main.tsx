import React from 'react'
import ReactDOM from 'react-dom/client'
import { LocalApp } from './LocalApp'
import { TaskActivityWindow } from './TaskActivityWindow'
import { WriteApprovalWindow } from './WriteApprovalWindow'
import './index.css'

const surface = new URLSearchParams(window.location.search).get('surface')
let app = <LocalApp />
if (surface === 'write-approval') app = <WriteApprovalWindow />
if (surface === 'task-activity') app = <TaskActivityWindow />

ReactDOM.createRoot(document.getElementById('root')!).render(app)
