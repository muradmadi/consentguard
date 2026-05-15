const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const ADMIN_SECRET = import.meta.env.VITE_ADMIN_SECRET || 'dev-admin-secret';

export async function fetchStats() {
  const res = await fetch(`${API_BASE}/api/stats`, {
    headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` }
  });
  return res.json();
}

export async function fetchRules() {
  const res = await fetch(`${API_BASE}/api/rules`, {
    headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` }
  });
  return res.json();
}

export async function updateRule(id: string, rule: any) {
  const res = await fetch(`${API_BASE}/api/rules/${id}`, {
    method: 'PUT',
    headers: { 
      'Authorization': `Bearer ${ADMIN_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(rule)
  });
  return res.json();
}

export async function fetchAuditLogs() {
  const res = await fetch(`${API_BASE}/audit`, {
    headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` }
  });
  return res.json();
}
