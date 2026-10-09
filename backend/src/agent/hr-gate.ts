/**
 * Payroll privacy (plan D7, P7): the HR tools answer with totals. Names and one person's pay go out only when the
 * message being answered asks for them in its own words: a person's name or code, "who", "names", "each", "salary
 * of …", "top peelers" … Rule-based, like the effect gate: text the model read (a tool result, an earlier turn) cannot
 * turn names on, and the model's own `names: true` is not enough without it.
 *
 * And the role gate in words: a manager or office user asking about payroll, salaries of people, attendance or leave
 * gets a plain no without the model (the HR tools are admin-only, so the model would have nothing anyway).
 */

const NAMES_ASKED =
  /\b(?:names?|name[- ]?wise|who(?:'s|\s+is|\s+are|\s+was|\s+were|\s+has|\s+had|\s+got|\s+took)?|whom|whose|each\s+(?:person|employee|worker|one|staff)|per\s+(?:person|employee|head|worker)|individual(?:ly|s)?|list\s+(?:of\s+)?(?:the\s+)?(?:staff|employees|people|workers|peelers|persons)|top\s+(?:\d+\s+)?peelers?|leaderboard|(?:salary|salaries|pay|wages?|payslip|net)\s+(?:of|for)\s+(?!the\s+month|june|july|august|september|october|november|december|january|february|march|april|may|this|last|\d)|payslip|how\s+much\s+(?:does|did|is|was)\s+\w+\s+(?:get|paid|earn|draw))\b/i
const EMPLOYEE_CODE_IN_TEXT = /\b(?:TFL|TF|T)\d{1,5}\b/i

/** Whether the message asks for people by name: a code (TF905), or words that ask who / names / one person's pay. */
export function namesAsked(text: string | null | undefined): boolean {
  if (!text) return false
  return NAMES_ASKED.test(text) || EMPLOYEE_CODE_IN_TEXT.test(text)
}

const HR_QUESTION =
  /\b(?:payroll|payslips?|pay\s*slips?|salary\s+(?:register|slip|sheet|of|for|details)|salaries\s+(?:of|for)|attendance|leave\s+(?:requests?|report|balance|taken|applied)|on\s+leave|absentees?|absent\s+(?:today|yesterday|on|in)|headcount|head\s+count|peeling\s+incentive|attendance\s+incentive|esi\s+(?:of|for|deducted)|pf\s+(?:of|for|deducted)|who\s+(?:is|was|were)\s+absent)\b/i

/** A payroll / attendance / leave question (for the admin-only refusal). Salary *payments* stay a finance question. */
export function isHrQuestion(text: string): boolean {
  return HR_QUESTION.test(text)
}

export const PAYROLL_ONLY = 'Payroll, attendance and leave are for the admin only.'
export const NAMES_WITHHELD =
  'Names and individual pay are only given when the admin asks for a person (by name or code) or for names in the message itself.'

/**
 * A payroll question without its employee codes, for the document pre-resolver: there TF905 is a person, not invoice
 * TF/26-27/5. A full document number (TF/26-27/101) has slashes and stays.
 */
export function withoutEmployeeCodes(text: string): string {
  return text.replace(/\b(?:TFL|TF|T)\d{1,5}\b(?!\s*\/)/gi, ' ')
}
