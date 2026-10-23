import type { Store } from '../db/store'
import type { NewJob } from '../db/types'
import type { PoRead } from '../domain/po'
import type { DataBrief } from '../queries/brief'
import type { SapSql } from '../sap/db'
import type { EvolutionClient } from '../whatsapp/evolution'
import type { FileStore } from '../files/store'
import type { BotMode } from '../whatsapp/parse'
import type { Erpnext } from '../erp/erpnext'
import type { ApprovalIntentClassifier } from './approval-intent'
import type { CallClassifier, ProceedClassifier } from './classifiers'
import type { ChatModel } from './llm'

export type AgentDeps = {
  store: Store
  evolution: EvolutionClient
  /** The app's postgres-js client; the SAP read model is the erp views in the same database. */
  sapSql: SapSql
  /** Where SAP attachment files live (FILE_STORE). Without one, documents are described but never sent. */
  files?: FileStore | null
  /** Reads a received PDF as a customer purchase order (PO gate, Z_MAT_POPRINT or LLM reader, totals guard). */
  readPurchaseOrder: (pdf: Buffer) => Promise<PoRead>
  /** Open orders, short finished goods, the last day's dispatch and open tasks (the factory_brief tool). */
  dataBrief: () => Promise<DataBrief>
  /** The tool-calling chat model (OPENAI_AGENT_MODEL). */
  chatModel: ChatModel
  /** TypeSafe's reading of an unclear admin message about a pending sales order; null without TYPESAFE_API_KEY (the chat model is used instead). */
  approvalIntent?: ApprovalIntentClassifier | null
  /** TypeSafe's call on whether a group message that names Tierra speaks to the bot; null without TYPESAFE_API_KEY (rules only). */
  callClassifier?: CallClassifier | null
  /** TypeSafe's reading of the admin's own words about a PO waiting for *proceed*; null without TYPESAFE_API_KEY (only *proceed* works). */
  proceedIntent?: ProceedClassifier | null
  /** Queues background work (WhatsApp turns, task notices). False when that idempotency key was already queued. */
  enqueue: (job: NewJob) => Promise<boolean>
  botMode: BotMode
  now: () => Date
  /** ERP_BACKEND=erpnext: the ERPNext REST client and mirror. Null/absent with SAP (the office keys SAP itself). */
  erpnext?: Erpnext | null
  /** The tool loop's time budget; 40 s unless a test shortens it. */
  agentBudgetMs?: number
}
