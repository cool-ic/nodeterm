export interface MailMember { node: string; session: string; cwd: string; wake?: boolean; transcript?: string }
export function emptyCodexPrompt(screen: string): boolean
export function transcriptPhase(file: string | undefined, session: string): string
export function startMailWake(pointer: string, deps: {
  authorized(project: string, member: MailMember): boolean
  wake(member: MailMember, prompt: string, ready: () => boolean, claim: () => boolean): Promise<'sent' | 'held' | 'uncertain'>
  error?(message: string): void
}): () => void
