import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import SidePanel from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
)
