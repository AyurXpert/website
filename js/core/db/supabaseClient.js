import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm'
import { ENV } from '../../config/env.js'
import { getTabUser, jwtClaims, blockTab, isTabBlocked } from '../tabUser.js'

// TODO §250: every request carries the browser's ONE shared sign-in. If this tab was
// opened as another user (or the tab is already blocked), refuse the request here,
// before it leaves the browser, and cover the page -- a save must never go out under
// the wrong person. Sign-in / token refresh / sign-out (/auth/v1/) always pass.
function _tabUserFetch(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || '')
  const pinned = getTabUser()
  if (pinned && !url.includes('/auth/v1/')) {
    const headers = new Headers(init?.headers || (typeof input === 'object' ? input.headers : undefined))
    const claims = jwtClaims((headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''))
    if (isTabBlocked() || (claims && claims.sub !== pinned)) {
      blockTab(claims?.email || '')
      return Promise.reject(new Error('This page was opened as another user. Reload to continue.'))
    }
  }
  return fetch(input, init)
}

export const supabase = createClient(
  ENV.SUPABASE_URL,
  ENV.SUPABASE_ANON_KEY,
  { global: { fetch: _tabUserFetch } }
)
