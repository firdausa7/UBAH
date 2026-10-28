import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import './fonts.css'
import './index.css'
import { RequireRole, SessionProvider, Waiting } from './lib/session.jsx'
import Login from './pages/auth/Login.jsx'
import GirlApp from './pages/girl/GirlApp.jsx'

// Workers' and admins' screens load only when someone opens them, so girls' phones never download them.
const WorkerApp = lazy(() => import('./pages/worker/WorkerApp.jsx'))
const AdminApp = lazy(() => import('./pages/admin/AdminApp.jsx'))

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Suspense fallback={<Waiting />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/me/*"
              element={
                <RequireRole role="girl">
                  <GirlApp />
                </RequireRole>
              }
            />
            <Route
              path="/worker/*"
              element={
                <RequireRole role="health_worker">
                  <WorkerApp />
                </RequireRole>
              }
            />
            <Route
              path="/admin/*"
              element={
                <RequireRole role="admin">
                  <AdminApp />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Suspense>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
