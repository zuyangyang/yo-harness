/**
 * Register page.
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../hooks/useAuth.js';
import { useTheme } from '../hooks/useTheme.js';

export function RegisterPage(): JSX.Element {
  const navigate = useNavigate();
  const { register, isLoading, error, clearError } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [tenantId, setTenantId] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      await register(tenantId, username, password, email || undefined);
      navigate('/');
    } catch {
      // Error is handled by auth store
    }
  };

  return (
    <div className="auth-page">
      <button className="auth-theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo">
            <span className="auth-logo-icon"></span>
            <span>Yo-Harness</span>
          </div>
          <h1 className="auth-title">Create account</h1>
          <p className="auth-subtitle">Get started with Yo-Harness</p>
        </div>

        {error && (
          <div className="auth-error">
            <span>{error}</span>
            <button className="auth-error-close" onClick={clearError}>×</button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="auth-field">
            <label className="auth-label">Tenant ID</label>
            <input
              className="input"
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label className="auth-label">Username</label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label className="auth-label">Email (optional)</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="auth-field">
            <label className="auth-label">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            className="btn btn-primary auth-submit"
            type="submit"
            disabled={isLoading}
          >
            {isLoading ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
