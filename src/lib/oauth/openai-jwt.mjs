/**
 * Decode OpenAI / ChatGPT OAuth JWT claims (access_token / id_token).
 * Used for panel account labels and chatgpt-account-id headers — not auth validation.
 */

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

export function decodeJwtPayload(token) {
  try {
    const part = String(token || '')
      .trim()
      .split('.')[1]
    if (!part) return null
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

export function openaiIdentityFromJwt(token) {
  const payload = decodeJwtPayload(token)
  if (!payload) return { email: null, chatgpt_account_id: null }
  const auth = payload['https://api.openai.com/auth']
  const authObj = auth && typeof auth === 'object' ? auth : {}
  const profile = payload['https://api.openai.com/profile']
  const profileObj = profile && typeof profile === 'object' ? profile : {}
  const email = firstString(
    payload.email,
    payload.email_address,
    payload.preferred_username,
    authObj.email,
    authObj.user_email,
    authObj.account_email,
    profileObj.email,
  )
  const chatgpt_account_id = firstString(authObj.chatgpt_account_id, authObj.account_id, authObj.user_id)
  return {
    email: email || null,
    chatgpt_account_id: chatgpt_account_id || null,
  }
}

/** Prefer id_token (openid profile); fill gaps from access_token. */
export function openaiIdentityFromOauthTokens({ id_token, access_token, idToken, accessToken } = {}) {
  const fromId = openaiIdentityFromJwt(id_token || idToken)
  const fromAccess = openaiIdentityFromJwt(access_token || accessToken)
  return {
    email: firstString(fromId.email, fromAccess.email) || null,
    chatgpt_account_id: firstString(fromId.chatgpt_account_id, fromAccess.chatgpt_account_id) || null,
  }
}
