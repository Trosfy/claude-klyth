// OAuth clients are distinct protocols, not interchangeable login presentations.
const issuer = 'https://auth.openai.com'
export const OFFICIAL_PROFILE = {
  name: 'official', issuer, resource: 'https://api.openai.com/v1', clientId: 'dynamic_agent_client',
  authorizeUrl: `${issuer}/api/accounts/authorize`, tokenUrl: `${issuer}/api/accounts/oauth/token`,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
} as const
