export interface ImIdentity { project: string; node: string; session: string; cli: string; generation: string }
export class ImRuntime {
 constructor(path: string)
 notice(identity:ImIdentity,payload:Record<string,unknown>,command:string): unknown
 wake(identity:ImIdentity,transport:(text:string,ready:()=>boolean,claim:()=>boolean)=>Promise<string>,command:string):Promise<string>
 rememberOwner(identity:ImIdentity,proof:unknown):void
 recoveryCandidates():Array<ImIdentity & {proof:string;phase:string}>
 recover(identity:ImIdentity,proof:unknown):boolean
 close(): void
 attach(identity: ImIdentity): string
 observe(identity: ImIdentity, event: {sequence:number;event:string;at?:number}): boolean
 dispatch(identity: ImIdentity, op:string,args?:string[],input?:unknown): unknown
 eligibility(identity:ImIdentity, options?:{now?:number;maxAge?:number;draft?:boolean;approval?:boolean}): string
}
