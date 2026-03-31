'use client';

import { useState, useEffect } from 'react';
import { fetchTasks } from '@/lib/api';
import type { Task } from '@/lib/types';

function formatDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function getStatus(task: Task): string {
  if (task.completed_at) return 'completed';
  if (task.due_at) {
    const due = new Date(task.due_at);
    if (!isNaN(due.getTime()) && due < new Date()) return 'overdue';
  }
  return task.status ?? 'pending';
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTasks()
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--text-muted)' }}>
        <span className="loading-spinner" /> Loading tasks...
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 8 }}>
        No scheduled tasks.
      </div>
    );
  }

  return (
    <div className="task-board">
      <table className="task-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Assigned To</th>
            <th>Created By</th>
            <th>Due</th>
            <th>Cadence</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => {
            const status = getStatus(task);
            return (
              <tr key={task.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{task.name}</div>
                  {task.description && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {task.description}
                    </div>
                  )}
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{task.assigned_to ?? '—'}</td>
                <td style={{ color: 'var(--text-muted)' }}>{task.created_by ?? '—'}</td>
                <td style={{ fontSize: 12 }}>{formatDate(task.due_at)}</td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {task.cadence_hours ? `${task.cadence_hours}h` : '—'}
                </td>
                <td>
                  <span className={`task-status ${status}`}>{status}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
