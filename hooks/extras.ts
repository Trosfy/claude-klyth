// The extra sign-in client of this build: none.
import type { ExtraClient } from './extra-client'

export type ExtraClientId = never
export type ExtraMethod = never
export const extraClient: ExtraClient<ExtraClientId, ExtraMethod> | undefined = undefined
