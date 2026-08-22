import { useState } from 'react'
import { X, Plus, Trash2, Save } from 'lucide-react'
import type { DestinationRule } from '@sluice/shared'

interface RuleEditorProps {
  rule: DestinationRule
  onClose: () => void
  onSave: (updatedRule: DestinationRule) => void
}

export function RuleEditor({ rule, onClose, onSave }: RuleEditorProps) {
  const [editedRule, setEditedRule] = useState<DestinationRule>({ ...rule })

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

  const updateTransformation = (index: number, field: string, value: string) => {
    const newTransforms = [...editedRule.transformations]
    newTransforms[index] = { ...newTransforms[index], [field]: value }
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
          <div className="form-group">
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
