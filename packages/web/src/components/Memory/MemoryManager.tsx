/**
 * 记忆管理：列表 + 搜索 + 创建/编辑/删除。
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type Memory, type MemoryCategory } from '../../api/client.js';

const CATEGORIES: MemoryCategory[] = ['general', 'preference', 'environment', 'project_knowledge'];

interface MemoryFormData {
  title: string;
  content: string;
  category: MemoryCategory;
  description: string;
  keywords: string;
}

const EMPTY_FORM: MemoryFormData = {
  title: '',
  content: '',
  category: 'general',
  description: '',
  keywords: '',
};

export function MemoryManager(): JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState<MemoryCategory | ''>('');
  const [isLoading, setIsLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<MemoryFormData>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);

  const loadMemories = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = searchQuery
        ? await api.memories.search(searchQuery, filterCategory || undefined)
        : await api.memories.list();
      setMemories(
        filterCategory && searchQuery
          ? res.memories
          : filterCategory
            ? res.memories.filter((m) => m.category === filterCategory)
            : res.memories,
      );
    } catch {
      // silently fail — user sees empty list
    } finally {
      setIsLoading(false);
    }
  }, [searchQuery, filterCategory]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const handleSearch = useCallback(() => {
    void loadMemories();
  }, [loadMemories]);

  const handleCreate = useCallback(async () => {
    try {
      await api.memories.create({
        title: form.title,
        content: form.content,
        category: form.category,
        description: form.description,
        keywords: form.keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadMemories();
    } catch {
      // ignore
    }
  }, [form, loadMemories]);

  const handleUpdate = useCallback(async () => {
    if (!editingId) return;
    try {
      await api.memories.update(editingId, {
        title: form.title,
        content: form.content,
        category: form.category,
        description: form.description,
        keywords: form.keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
      });
      setEditingId(null);
      setForm(EMPTY_FORM);
      await loadMemories();
    } catch {
      // ignore
    }
  }, [editingId, form, loadMemories]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.memories.delete(id);
        await loadMemories();
      } catch {
        // ignore
      }
    },
    [loadMemories],
  );

  const startEdit = useCallback((mem: Memory) => {
    setEditingId(mem.id);
    setForm({
      title: mem.title,
      content: mem.content,
      category: mem.category,
      description: mem.description,
      keywords: mem.keywords.join(', '),
    });
    setShowForm(true);
  }, []);

  return (
    <div className="memory-manager">
      <h2>Memory Manager</h2>

      <div className="memory-toolbar">
        <input
          type="text"
          placeholder="Search memories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value as MemoryCategory | '')}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}>
          + New
        </button>
      </div>

      {showForm && (
        <div className="memory-form">
          <input
            type="text"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <textarea
            placeholder="Content"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            rows={4}
          />
          <select
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as MemoryCategory })}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <input
            type="text"
            placeholder="Keywords (comma-separated)"
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
          />
          <div className="memory-form-actions">
            <button onClick={editingId ? handleUpdate : handleCreate}>
              {editingId ? 'Update' : 'Create'}
            </button>
            <button onClick={() => { setShowForm(false); setEditingId(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p>Loading...</p>
      ) : memories.length === 0 ? (
        <p>No memories found.</p>
      ) : (
        <ul className="memory-list">
          {memories.map((mem) => (
            <li key={mem.id} className="memory-item">
              <div className="memory-item-header">
                <strong>{mem.title}</strong>
                <span className={`memory-badge memory-badge--${mem.category}`}>{mem.category}</span>
              </div>
              <p className="memory-item-content">{mem.content}</p>
              {mem.keywords.length > 0 && (
                <div className="memory-item-keywords">
                  {mem.keywords.map((kw) => (
                    <span key={kw} className="memory-keyword">{kw}</span>
                  ))}
                </div>
              )}
              <div className="memory-item-actions">
                <button onClick={() => startEdit(mem)}>Edit</button>
                <button onClick={() => handleDelete(mem.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
