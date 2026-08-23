import { useState } from 'react'
import { X, Plus, Trash2, Save } from 'lucide-react'
import type { DestinationRuleView } from '@sluice/shared'

interface RuleEditorProps {
  rule: DestinationRuleView
  onClose: () => void
  onSave: (updatedRule: DestinationRuleView) => void
}

/** Why a transport is a statement about the vendor rather than a setting. */
const TRANSPORT_HELP: Record<string, string> = {
  pixel: 'The payload is the query string, so scrubbing the URL scrubs all of it.',
  json: 'The payload is a JSON body sent to the endpoint the browser targeted.',
  opaque:
    'The payload is encoded, so neither scrub pass can read it. Only an adapter that decodes it can serve this vendor; without one the destination is refused at /ingest.',
}

export function RuleEditor({ rule, onClose, onSave }: RuleEditorProps) {
  const [editedRule, setEditedRule] = useState<DestinationRuleView>({ ...rule })

  const addTransformation = () => {
    setEditedRule({
      ...editedRule,
      transformations: [...editedRule.transformations, { path: '', action: 'strip' }],
    })
  }

  const removeTransformation = (index: number) => {
    const newTransforms = [...editedRule.transformations]
    newTransforms.splice(index, 1)
    setEditedRule({ ...editedRule, transformations: newTransforms })
  }

  /**
   * `mode` and `normalize` belong to a hash and are rejected by the rule schema
   * anywhere else, so moving a declared match key onto another action drops
   * them rather than saving a rule the proxy would refuse.
   */
  const updateTransformation = (index: number, field: string, value: string) => {
    const newTransforms = [...editedRule.transformations]
    const updated = { ...newTransforms[index], [field]: value }
    if (field === 'action' && value !== 'hash') {
      delete updated.mode
      delete updated.normalize
    }
    newTransforms[index] = updated
    setEditedRule({ ...editedRule, transformations: newTransforms })
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>Edit Rule: {rule.id}</h2>
          <button className="btn-icon" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {/* Read-only, like the match-key chip below and for the same reason.
              The transport is a fact about how the vendor's beacon is built,
              and the support level is derived from it — changing it in a
              dropdown would not change the vendor, it would only make the
              registry lie again. */}
          <div className="form-group">
            <label>Transport</label>
            <div
              style={{ fontSize: '12px', color: 'var(--accents-5)' }}
              title={TRANSPORT_HELP[editedRule.transport]}
            >
              <strong>{editedRule.transport}</strong> · support: {editedRule.support}
              <div style={{ marginTop: '4px' }}>{TRANSPORT_HELP[editedRule.transport]}</div>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label>Category</label>
            <select
              value={editedRule.category}
              onChange={(e) => setEditedRule({ ...editedRule, category: e.target.value })}
            >
              <option value="analytics">Analytics</option>
              <option value="marketing">Marketing</option>
              <option value="necessary">Necessary</option>
              <option value="personalization">Personalization</option>
            </select>
          </div>

          <div style={{ marginTop: '24px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
              }}
            >
              <h3>Transformations</h3>
              <button className="btn btn-secondary btn-sm" onClick={addTransformation}>
                <Plus size={14} style={{ marginRight: '4px' }} /> Add
              </button>
            </div>

            <div className="transformation-list">
              {editedRule.transformations.map((t, i) => (
                <div key={i} className="transformation-item">
                  <input
                    type="text"
                    placeholder="JSON Path (e.g. user.email)"
                    value={t.path}
                    onChange={(e) => updateTransformation(i, 'path', e.target.value)}
                  />
                  <select
                    value={t.action}
                    onChange={(e) => updateTransformation(i, 'action', e.target.value)}
                    style={{ width: '100px' }}
                  >
                    <option value="strip">Strip</option>
                    <option value="hash">Hash</option>
                    <option value="redact">Redact</option>
                  </select>
                  {t.mode === 'match_key' && (
                    // Read-only on purpose: an unsalted digest the vendor can
                    // join on is a decision that belongs in a reviewed rule, not
                    // in a dropdown. Removing the row removes the match key.
                    <span
                      title={`Vendor match key, normalised as ${t.normalize}. Unsalted — the vendor can match this digest.`}
                      style={{ fontSize: '11px', color: 'var(--accents-5)', whiteSpace: 'nowrap' }}
                    >
                      match key · {t.normalize}
                    </span>
                  )}
                  {t.action === 'redact' && (
                    <input
                      type="text"
                      placeholder="Pattern (regex)"
                      value={t.pattern || ''}
                      onChange={(e) => updateTransformation(i, 'pattern', e.target.value)}
                    />
                  )}
                  <button className="btn-icon text-error" onClick={() => removeTransformation(i)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave(editedRule)}>
            <Save size={16} style={{ marginRight: '8px' }} /> Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}
