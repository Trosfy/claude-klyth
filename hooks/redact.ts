// Masking of what looks like a credential, applied to every provider text klyth logs or shows, and the first
// line of a text. Pure, and shared: klythd imports it as the mod does.

// Masks bearer tokens, sk- keys, key/token/secret assignments and any long credential-shaped run.
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9._-]+/g, '[REDACTED]')
    .replace(/((?:api[-_]?key|token|secret)["':= ]+)\S+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9._~+/=-]{24,}/g, '[REDACTED]')
}

export const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
