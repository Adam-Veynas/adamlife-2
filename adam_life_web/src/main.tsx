import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthRoot } from './auth/AuthRoot'
import './styles.css'
import './theme/theme.css'
import './ux.css'
import './auth/auth.css'
import { applyTheme } from './theme/palettes'

applyTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthRoot /></React.StrictMode>)
