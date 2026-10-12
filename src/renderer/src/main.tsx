import './assets/fonts.css'
import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_APP_SETTINGS } from '../../shared/ipc-contract'
import App from './App'
import { applyDocumentTheme, applySidebarWidth } from './lib/workspace-theme'

applyDocumentTheme('dark')
applySidebarWidth(DEFAULT_APP_SETTINGS.sidebarWidth)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
