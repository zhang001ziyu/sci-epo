/** Private owner administration DTOs. Credentials never cross this boundary. */
export const CREATIVE_ROLES = ['writing','quality','revision'] as const;
export type CreativeRole = typeof CREATIVE_ROLES[number];
export type WireProtocol = 'chat_completions'|'responses'|'messages'|'generateContent';
export interface ProviderRef { id:string; revision:number }
export interface ConnectionConfig { name:string; baseUrl:string; protocol:WireProtocol }
export interface ManagedModelConfig { name:string; connectionId:string; connectionRevision:number; modelId:string; reasoningEffort:string; maxOutput:number; timeoutMs:number }
export interface ProviderEntity<T> extends ProviderRef { enabled:boolean; config:T }
export interface ModelValidation { status:'running'|'passed'|'failed'|'inherited'; message:string; testedAt:string }
export interface ManagedModel extends ProviderEntity<ManagedModelConfig> { validation:ModelValidation|null; qualified:boolean }
export interface ProviderRouting { version:number; roles:Record<CreativeRole,ProviderRef>|null; createdAt:string|null }
export interface ProviderCatalog { connections:(ProviderEntity<ConnectionConfig>&{keyConfigured:boolean})[]; models:ManagedModel[]; activeModels:ManagedModel[]; routing:ProviderRouting; source:string|null }
export interface ModelSnapshot { routingVersion:number; role:CreativeRole; modelRef:ProviderRef; connectionRef:ProviderRef; modelName:string; modelId:string; connectionName:string; protocol:WireProtocol }
