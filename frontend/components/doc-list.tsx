import type { DocFile } from '@/lib/types'

const ROLE_LABEL: Record<string, string> = {
  invoice_pdf: 'Invoice',
  ewaybill: 'E-way bill',
  einvoice_qr: 'QR',
  credit_note_pdf: 'Credit note',
  debit_note_pdf: 'Debit note',
  ap_invoice_pdf: 'Bill print',
  po_pdf: 'PO print',
  so_pdf: 'SO print',
  receipt_pdf: 'Receipt',
  supporting: 'Attachment',
}

export function fileLabel(file: DocFile): string {
  return ROLE_LABEL[file.role] ?? 'File'
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The SAP files on record for a document, as small links that open in a new tab. `compact` (table cells) shows
 * the kind only; the full form adds the file name and size. Nothing on record: a muted dash, or `empty`.
 */
export function DocList({ files, compact = false, empty }: { files: DocFile[] | undefined; compact?: boolean; empty?: string }) {
  if (!files || files.length === 0) return <span className="muted">{empty ?? '—'}</span>
  return (
    <span className={compact ? 'doclist compact' : 'doclist'}>
      {files.map((file) => (
        <a
          key={`${file.sha256}-${file.role}`}
          className="docchip"
          href={file.href}
          target="_blank"
          rel="noreferrer"
          title={`${file.fileName} · ${size(file.sizeBytes)}`}
        >
          {fileLabel(file)}
          {compact ? null : <span className="docname">{` ${file.fileName} · ${size(file.sizeBytes)}`}</span>}
        </a>
      ))}
    </span>
  )
}
