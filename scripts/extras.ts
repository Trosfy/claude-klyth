// The public build has no optional node sign-in client.
import type { ExtraSignIn } from './extra-sign-in'
export type ExtraClientId = never
export type ExtraMethod = never
export const extraSignIn: ExtraSignIn<ExtraClientId, ExtraMethod> | undefined = undefined
